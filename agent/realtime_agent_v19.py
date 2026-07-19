"""
ailivex-realtime-agent v19 — LiveKit Agent 核心邏輯（= v18 + 方法論共創提案工具）

v18 差異：只加 propose_method / propose_knowledge 原生 function tool——
訓練師（admin）閘過才注入共創指令＋掛工具（2026-07-19 起 admin 對所有角色恆開，角色旗標退役）；
提案落 methodologies status='draft'（不嵌 triggerEmb——轉正時後台補嵌；不動 methodologyCount）。
一般用戶通話與 v18 行為完全一致（閘不過＝指令不注入、工具不掛）。

v17.4 差異：session.output.audio 外包一層 GatedPauseOutput——音量沒提高的聲音
（咳嗽/應和/背景音）不再暫停角色語音，零死空氣；音量提高＝真搶話企圖照常暫停；
真打斷 commit（轉寫成句）直通立即停，體感與 v17 一致。詳見 agent/interrupt_gate.py。

v16 差異（只動延遲，不動功能）：
  1. VAD prewarm：模型在 prewarm_fnc 載一次進 proc.userdata，每通電話省 1-3s 載入
  2. VAD min_silence_duration 0.4→0.3：端點判定更快（配後台 responseSpeed 旋鈕）
  3. TTS 首段提早 flush（first_segment_max_chars=16）：壓首聲延遲

完全對齊 ailive realtime_agent.py 的 1.5.x API 寫法：
  - session.start(agent=agent, room=ctx.room)  (無 participant)
  - @session.on("conversation_item_added")
  - @ctx.room.on("disconnected")
  - session.generate_reply() 主動打招呼

ailivex 差異：
  - Collections: characters / conversations / memories（無 platform_ prefix）
  - 記憶綁 (userId × characterId)
  - Soul: soulCore → soul（無四層）
  - PROJECT_NAMESPACE = ailivex
"""
import asyncio
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv
load_dotenv(ROOT_DIR / ".env")

from livekit.agents import Agent, AgentSession, JobContext, function_tool
from livekit.plugins import silero, anthropic, soniox
from agent.minimax_tts import MiniMaxCustomTTS
from agent.interrupt_gate import GatedPauseOutput, VolumeGate
from agent.conv_tuning import build_turn_handling, get_temperature
from agent.source_intake import handle_share_source
from agent.quota_meter import VoiceMeter, consume_doc_quota, consume_media_quota
from livekit import api as lk_api
from agent.firestore_loader import (
    load_memories_for_recall, cosine_similarity, bump_hits, generate_embedding,
    load_character,
    load_conversation,
    load_memories,
    load_relationship,
    save_conversation,
    write_memory,
    build_system_prompt,
    extract_and_save_memories,
    extract_session_summary,
    fetch_remote_memory_blocks,
    post_diary_write,
    post_extract_memories,
    update_last_session,
    create_document_job,
    dispatch_task_job,
    dispatch_script_draft,
    dispatch_story_draft,
)

# v16.5 不再自掛 basicConfig handler：livekit cli 的 setup_logging 會往 root 加唯一出口
# （production=JSON stdout）。過去 basicConfig(stderr) 疊上去＝同一行 log 印三次
# （主進程 stderr＋job 子進程 stderr＋livekit JSON stdout）。查 log 改看 jsonPayload.message。
logger = logging.getLogger("ailivex-realtime-v18")

PROJECT_NAMESPACE = os.environ.get("PROJECT_NAMESPACE", "ailivex")


def load_vad():
    """v16: 供 prewarm_fnc 與 dev fallback 共用的 VAD 載入（參數單一真相源）。
    注意：prewarm 全 process 共用一顆 → min_silence 是全域值，不能 per 角色。"""
    return silero.VAD.load(
        min_silence_duration=0.3,   # v16: 0.4→0.3 端點更快；再低會把換氣當講完
        prefix_padding_duration=0.3,
        min_speech_duration=0.1,
        activation_threshold=0.5,
    )

FALLBACK_PROMPT = (
    "你是一個禮貌的 AI 助手。這是即時語音通話。"
    "用簡體中文回覆（TTS 發音穩定），一兩句話，不要 stage directions。"
)


def _sanitize_chat_ctx(chat_ctx) -> None:
    """就地修掉會炸 Anthropic 400 'text content blocks must contain non-whitespace
    text' 的兩個來源（讀網址 session.interrupt() 後 generate_reply 整則死掉）：
      ① chat_ctx 裡的空白/空 content block 與整則空訊息。
      ② 真正的元兇：livekit anthropic plugin 對 claude-4.6（disables prefill）若
         偵測到對話以 assistant 結尾，會自動 append 一則「只有一個空格」的 user
         訊息（_provider_format/anthropic.py），Anthropic 直接 400。這則是在
         to_provider_format 內部生的，sanitize items 攔不到 → 改成：若轉換後最後
         一則是 assistant，搶先補一則非空白的 '(empty)' user（plugin 自己 leading
         dummy 用的同一個慣用值），plugin 條件不成立就不會再塞那個空格。
    釘在 chat_ctx → Anthropic 的咽喉，所有 generate_reply 都受保護。
    v17.4：我們補的 '(empty)' 佔位是持久寫入 chat_ctx 的——不先清掉，多次
    assistant 結尾的生成（讀網址等）會讓幻影 user 訊息越積越多，模型可能把
    「(empty)」當成用戶沉默去回應。改為每次先清舊佔位、需要時再補，全程最多一則。"""
    items = chat_ctx.items
    kept = []
    for it in items:
        if type(it).__name__ == "ChatMessage":
            content = getattr(it, "content", None)
            if isinstance(content, list):
                content[:] = [
                    b for b in content
                    if not (isinstance(b, str) and not b.strip())
                ]
                if len(content) == 0:
                    continue
                # 清掉我們先前補的 '(empty)' 佔位（只認 user + 單一 '(empty)' 內容）
                if (getattr(it, "role", "") == "user"
                        and len(content) == 1 and content[0] == "(empty)"):
                    continue
        kept.append(it)
    items[:] = kept

    try:
        msgs, _ = chat_ctx.to_provider_format(format="anthropic")
        if msgs and msgs[-1].get("role") == "assistant":
            chat_ctx.add_message(role="user", content=["(empty)"])
    except Exception as e:
        logger.warning(f"_sanitize_chat_ctx trailing-assistant guard skipped: {e}")


class SanitizingAgent(Agent):
    async def stt_node(self, audio, model_settings):
        # v18 音量閘 tap：複製一份 frame 給 VolumeGate 量 RMS，frame 照樣餵 STT。
        # （v11 聲紋同款帶內 tap；gate 缺席時零開銷直通）
        gate = getattr(self, "_volume_gate", None)
        if gate is None:
            async for ev in Agent.default.stt_node(self, audio, model_settings):
                yield ev
            return

        async def _tapped():
            async for f in audio:
                gate.push(f)
                yield f

        async for ev in Agent.default.stt_node(self, _tapped(), model_settings):
            yield ev

    async def llm_node(self, chat_ctx, tools, model_settings):
        _sanitize_chat_ctx(chat_ctx)
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk


# ── v19 方法論共創（語音提案管道）────────────────────────────────────────────

def check_method_proposal_gate(user_id: str, character_id: str) -> bool:
    """共創閘：users/{uid}.role=='admin' 即通過（2026-07-19 Adam 定案：admin 對所有角色恆開，
    per-character methodProposalEnabled 旗標退役不再讀）。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    _ensure_init()
    db = firestore.client()
    u = db.collection("users").document(user_id).get()
    return bool(u.exists and (u.to_dict() or {}).get("role") == "admin")


def load_method_inventory(character_id: str) -> list:
    """共創語境用：角色現有 active 方法論清單（名字＋目的）。
    平常通話不載入——遞招不在語音線（2026-07-19 現況），這份清單只給訓練師對話。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    _ensure_init()
    db = firestore.client()
    snap = (db.collection("methodologies")
            .where("characterId", "==", character_id).limit(50).get())
    out = []
    for d in snap:
        m = d.to_dict() or {}
        if (m.get("status") or "active") == "active":
            out.append({"name": m.get("name", ""), "purpose": m.get("purpose", "")})
    return out


def generate_query_embedding_multilingual(text: str) -> list | None:
    """用戶語句 → multilingual-002 query 向量（與 TS generateKnowledgeEmbedding(text,'query') 對等）。
    知識塊/方法論 trigger 都是這顆嵌的（記憶池的 004 不互通——004 對中文短句 cosine 坍縮）。"""
    import urllib.request
    from agent.firestore_loader import _get_vertex_token
    token = _get_vertex_token()
    if not token:
        return None
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    project_id = json.loads(sa_json).get("project_id", "") if sa_json else ""
    url = (f"https://us-central1-aiplatform.googleapis.com/v1/projects/{project_id}"
           f"/locations/us-central1/publishers/google/models/text-multilingual-embedding-002:predict")
    body = json.dumps({"instances": [{"content": text, "task_type": "RETRIEVAL_QUERY"}],
                       "parameters": {"outputDimensionality": 768}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        values = (data.get("predictions") or [{}])[0].get("embeddings", {}).get("values")
        return values if isinstance(values, list) and len(values) == 768 else None
    except Exception as e:
        logging.getLogger(__name__).warning(f"[v19.1 embed] failed: {e}")
        return None


def load_knowledge_chunks(character_id: str) -> list:
    """通話開場把角色全部知識塊載進 RAM（現階段角色 <100 塊）；每輪只做本地 cosine，零額外讀。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    _ensure_init()
    db = firestore.client()
    snap = (db.collection("knowledge_chunks")
            .where("characterId", "==", character_id).limit(500).get())
    out = []
    for d in snap:
        m = d.to_dict() or {}
        emb = m.get("embedding")
        if isinstance(emb, list) and emb and m.get("content"):
            out.append({"id": d.id, "content": m["content"], "embedding": emb})
    return out


def load_methodology_defs(character_id: str) -> list:
    """active 方法論完整定義（含 triggerEmb 供選招、steps 供走步）。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    _ensure_init()
    db = firestore.client()
    snap = (db.collection("methodologies")
            .where("characterId", "==", character_id).limit(50).get())
    out = []
    for d in snap:
        m = d.to_dict() or {}
        if (m.get("status") or "active") != "active":
            continue
        emb = m.get("triggerEmb")
        if not (isinstance(emb, list) and emb):
            continue
        out.append({"id": d.id, "name": m.get("name", ""), "purpose": m.get("purpose", ""),
                    "preconditions": m.get("preconditions") or [],
                    "steps": m.get("steps") or [], "triggerEmb": emb})
    return out


def _s2t_converter():
    """語音 LLM 輸出慣性是簡體 → 落庫前確定性轉繁。s2tw 不用 s2twp（詞組改寫會修壞已繁體文本）。"""
    try:
        from opencc import OpenCC
        return OpenCC("s2tw").convert
    except Exception:
        return lambda x: x  # opencc 不可用時不阻斷（寧可簡體落庫，後台可編）


def write_knowledge_proposal(character_id: str, proposed_by: str, title: str,
                             content: str, source_note: str = "") -> str:
    """知識提案落 draft（knowledge_proposals）：不切塊不嵌入——
    角色會幻覺（Bacha Coffee 曾被記成 1876 咖啡），審核轉入庫才走 ingest 正式管線。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    from datetime import datetime, timezone
    _ensure_init()
    db = firestore.client()
    _s2t = _s2t_converter()
    title = _s2t((title or "").strip())
    content = _s2t((content or "").strip())
    source_note = _s2t((source_note or "").strip())
    if not (title and content):
        raise ValueError("title / content 缺漏")
    if len(content) > 50_000:
        raise ValueError("內容超過 50000 字上限")
    dup = (db.collection("knowledge_proposals")
           .where("characterId", "==", character_id)
           .where("title", "==", title)
           .where("status", "==", "draft").limit(1).get())
    if len(list(dup)) > 0:
        raise ValueError(f"已有同標題的待審提案《{title}》")
    doc = {
        "characterId": character_id,
        "title": title,
        "content": content,
        "proposedBy": proposed_by,
        "status": "draft",
        "createdAt": datetime.now(timezone.utc),
    }
    if source_note:
        doc["sourceNote"] = source_note
    _, ref = db.collection("knowledge_proposals").add(doc)
    return ref.id


def write_method_proposal(character_id: str, proposed_by: str, name: str, purpose: str,
                          trigger_desc: str, preconditions: list, steps: list) -> str:
    """提案落 draft（確定性驗證，對齊 TS saveMethodologyProposal）：
    不嵌 triggerEmb（語音端無 multilingual embedding——轉正時後台 approve route 補嵌，收斂點唯一）；
    不動 methodologyCount（相容開關語意 = active 數，轉正才 +1）。"""
    from agent.firestore_loader import _ensure_init
    from firebase_admin import firestore
    from datetime import datetime, timezone
    _ensure_init()
    db = firestore.client()
    # 語音 LLM 輸出慣性是簡體（2026-07-19 首例《品牌故事解构法》全簡落庫）→ 落庫前確定性轉繁
    _s2t = _s2t_converter()
    name = _s2t((name or "").strip())
    purpose = _s2t((purpose or "").strip())
    trigger_desc = _s2t((trigger_desc or "").strip())
    preconditions = [_s2t(str(p)) for p in (preconditions or [])]
    steps = [
        {**s, "instruction": _s2t(str(s.get("instruction", ""))),
         **({"exitCondition": _s2t(str(s["exitCondition"]))} if s.get("exitCondition") else {})}
        if isinstance(s, dict) else s
        for s in (steps or [])
    ]
    if not (name and purpose and trigger_desc):
        raise ValueError("name / purpose / trigger_desc 缺漏")
    clean_steps = []
    for i, s in enumerate(steps or []):
        if not isinstance(s, dict):
            raise ValueError("steps 每一步都要是物件（{instruction, exitCondition}）")
        instruction = str(s.get("instruction", "") or "").strip()
        if not instruction:
            raise ValueError(f"第 {i + 1} 步缺 instruction")
        step = {"order": i + 1, "instruction": instruction}
        exit_cond = str(s.get("exitCondition", "") or "").strip()
        if exit_cond:
            step["exitCondition"] = exit_cond
        clean_steps.append(step)
    if not clean_steps or len(clean_steps) > 20:
        raise ValueError("steps 需為 1-20 步")
    dup = (db.collection("methodologies")
           .where("characterId", "==", character_id)
           .where("name", "==", name).limit(1).get())
    if len(list(dup)) > 0:
        raise ValueError(f"已有同名方法論《{name}》（可能已提過或已在庫）")
    _, ref = db.collection("methodologies").add({
        "characterId": character_id,
        "name": name,
        "purpose": purpose,
        "triggerDesc": trigger_desc,
        "preconditions": [str(p).strip() for p in (preconditions or []) if str(p).strip()],
        "steps": clean_steps,
        "status": "draft",
        "proposedBy": proposed_by,
        "createdAt": datetime.now(timezone.utc),
    })
    return ref.id


async def entrypoint(ctx: JobContext):
    logger.info(f"Job dispatched: room={ctx.room.name}")

    if not ctx.room.name.startswith(f"{PROJECT_NAMESPACE}-"):
        logger.critical(
            f"SECURITY: Room '{ctx.room.name}' lacks '{PROJECT_NAMESPACE}-' prefix. Rejecting."
        )
        return

    dispatch_metadata = {}
    try:
        if ctx.job.metadata:
            dispatch_metadata = json.loads(ctx.job.metadata)
            logger.info(f"Job metadata: {dispatch_metadata}")
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning(f"Job metadata parse failed: {e}")

    character_id = dispatch_metadata.get("characterId", "")
    user_id = dispatch_metadata.get("userId", "")
    conv_id = dispatch_metadata.get("convId", "")
    # 用量管制：token route 塞進 metadata 的剩餘語音秒數（None/缺失 = 不限，admin 一律不限）
    voice_seconds_remaining = dispatch_metadata.get("voiceSecondsRemaining", None)
    if not isinstance(voice_seconds_remaining, (int, float)):
        voice_seconds_remaining = None

    system_prompt = FALLBACK_PROMPT
    char_ctx = None
    conv_ctx = None
    memories = []   # v15：_recall 初始化會引用，metadata 缺失時不能 NameError（共用 loader 教訓）

    if character_id:
        try:
            # v17：remote 記憶塊（TS 組好含印象層/日記）先發併行 fetch，
            # 與下面的 Firestore 本地載入同時跑；6s 逾時 → (None,None) → fallback 本地組裝
            _remote_result = {}
            _remote_thread = None
            if user_id:
                def _fetch_remote():
                    _remote_result["blocks"] = fetch_remote_memory_blocks(user_id, character_id)
                _remote_thread = threading.Thread(target=_fetch_remote, daemon=True)
                _remote_thread.start()

            char_ctx = load_character(character_id)
            conv_ctx = load_conversation(conv_id) if conv_id else None
            memories = []
            relationship = None
            if user_id:
                try:
                    memories = load_memories(user_id, character_id, limit=15)
                except Exception as e:
                    logger.warning(f"load_memories failed: {e}")
                try:
                    relationship = load_relationship(user_id, character_id)
                except Exception as e:
                    logger.warning(f"load_relationship failed: {e}")

            class _EmptyConv:
                summary = ""
                messages = []

            _remote_blocks = None
            if _remote_thread is not None:
                _remote_thread.join(timeout=7)  # fetch 自身 6s 逾時，這裡兜底
                rb = _remote_result.get("blocks")
                if rb and rb[0]:
                    _remote_blocks = rb

            system_prompt = build_system_prompt(
                char_ctx, conv_ctx or _EmptyConv(), memories, relationship=relationship,
                user_id=user_id, remote_blocks=_remote_blocks
            )
            logger.info(f"[v18] remote_blocks={'hit' if _remote_blocks else 'fallback-local'}")
            logger.info(
                f"Loaded character={char_ctx.name} id={character_id} "
                f"soul_chars={len(char_ctx.soul_text)} memories={len(memories)} "
                f"voice={char_ctx.voice_id_minimax or '(default)'}"
            )
            # v15：讀命中計數（語音記憶也能升 core 了）
            _opening_ids = [m.get("id") for m in memories if m.get("id")]
            if _opening_ids:
                threading.Thread(target=bump_hits, args=(_opening_ids,), daemon=True).start()
        except Exception as e:
            logger.error(f"Firestore load failed, using fallback: {e}")

    await ctx.connect()
    logger.info("Connected to room, waiting for participant...")
    participant = await ctx.wait_for_participant()
    logger.info(f"Participant joined: {participant.identity}")

    # v16: VAD 從 prewarm 快取拿（main_v16 prewarm_fnc 已載好）；dev 直跑無 prewarm 時現載 fallback
    vad = (ctx.proc.userdata or {}).get("vad") or load_vad()

    soniox_key = os.environ.get("SONIOX_API_KEY", "")
    if not soniox_key:
        logger.critical("SONIOX_API_KEY missing")
        return
    stt = soniox.STT(
        api_key=soniox_key,
        params=soniox.STTOptions(model="stt-rt-v4", language_hints=["zh", "en"]),
    )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        logger.critical("ANTHROPIC_API_KEY missing — realtime LLM requires direct paid key")
        return

    logger.info("LLM: direct Anthropic API key (realtime requires paid key; bridge not supported)")
    llm = anthropic.LLM(
        model="claude-sonnet-4-6",   # v2 深度版：用 Sonnet 取代 Haiku，換深度/帶入感（犧牲少許首句延遲）
        api_key=anthropic_key,
        temperature=get_temperature(char_ctx.conv_settings if char_ctx else {}, 0.4),  # 後台可調
        caching="ephemeral",
    )

    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    minimax_group_id = os.environ.get("MINIMAX_GROUP_ID", "")
    default_voice_id = os.environ.get("MINIMAX_DEFAULT_VOICE_ID", "Wise_Woman")

    if not minimax_key or not minimax_group_id:
        logger.critical("MINIMAX_API_KEY / MINIMAX_GROUP_ID missing")
        return

    char_voice_id = char_ctx.voice_id_minimax if char_ctx else ""
    voice_id = char_voice_id or default_voice_id
    vs = (char_ctx.voice_settings if char_ctx else {}) or {}
    speed = float(vs.get("speed", 1.0))
    pitch = int(vs.get("pitch", 0))
    vol = float(vs.get("vol", 1.0))
    emotion = vs.get("emotion", "")

    logger.info(f"TTS: MiniMax voice={voice_id} speed={speed} pitch={pitch} vol={vol} emotion={emotion or '(auto)'}")

    tts = MiniMaxCustomTTS(
        api_key=minimax_key,
        group_id=minimax_group_id,
        voice_id=voice_id,
        model="speech-2.6-hd",   # v2 試 HD 高品質（比 turbo 自然，首句稍慢）
        first_segment_max_chars=16,   # v16: 首段到逗號/16字就送 TTS，壓首聲延遲
        speed=speed,
        pitch=pitch,
        vol=vol,
        emotion=emotion,
    )

    # v19 共創閘：雙閘（admin×角色旗標）都過才掛提案工具；查失敗＝閘關（fails-safe）
    _proposal_enabled = False
    _method_inventory: list = []
    if user_id and character_id:
        try:
            _proposal_enabled = await asyncio.to_thread(
                check_method_proposal_gate, user_id, character_id)
        except Exception as e:
            logger.warning(f"[v19] proposal gate check failed（閘保持關）: {e}")
    if _proposal_enabled:
        try:
            _method_inventory = await asyncio.to_thread(load_method_inventory, character_id)
        except Exception as e:
            logger.warning(f"[v19] load_method_inventory failed: {e}")

    # ── v19.1 語音知識檢索＋遞招：開場載庫進 RAM（每輪只做本地 cosine）──────
    KNOW_FLOOR = 0.68    # 與文字線 KNOWLEDGE_FLOOR 同值（multilingual-002 量過的門檻，不另調）
    KNOW_TOP_K = 3
    METHOD_FLOOR = 0.70  # 與文字線 TRIGGER_FLOOR 同值
    _kchunks: list = []
    _mdefs: list = []
    if character_id:
        try:
            _kchunks, _mdefs = await asyncio.gather(
                asyncio.to_thread(load_knowledge_chunks, character_id),
                asyncio.to_thread(load_methodology_defs, character_id))
            if _kchunks or _mdefs:
                logger.info(f"[v19.1] loaded knowledge={len(_kchunks)} chunks, methodologies={len(_mdefs)}")
        except Exception as e:
            logger.warning(f"[v19.1] library load failed（本通無檢索/遞招）: {e}")
    # 走步狀態：通話進程內（掛斷即清，不與文字線的 conversation.activeMethodology 搶狀態）
    METHOD_REOFFER_COOLDOWN = 120.0  # exit/走完後同套冷卻秒數——剛收掉的招不馬上再遞（2026-07-19 實測發現）
    _mstate: dict = {"active": None, "step": 0, "offer_block": ""}
    _mcooldown: dict = {}  # method_id → 冷卻到期 ts
    _kinjected: set = set()
    _lookup_busy = {"on": False}

    @function_tool(name="remember", description="把重要的事記住，供下次對話回憶")
    async def remember_tool(content: str) -> str:
        if user_id and character_id:
            # v16.1: 同步 embedding+dedup+Firestore 會堵 event loop（說再見時模型批次存記憶=卡頓），一律下放 thread
            mem_id = await asyncio.to_thread(
                write_memory, user_id, character_id, content, source="voice", importance=6)
            logger.info(f"Memory saved: {mem_id} - {content[:80]}")
            return f"已記住：{content}"
        return "無法記憶（缺少 userId/characterId）"

    @function_tool(
        name="write_document",
        description="幫對方寫一份策略書、企劃書或正式文件。填入標題和文件要求，系統會非同步生成。"
    )
    async def write_document_tool(title: str, brief: str) -> str:
        if not user_id or not character_id:
            return "無法建立文件（缺少 userId/characterId）"
        # 用量閘（對齊 TS createDocumentJob）：transaction 查+扣，額度滿誠實告知
        try:
            if not await asyncio.to_thread(consume_doc_quota, user_id):
                logger.info(f"[quota] docs quota exhausted user={user_id}")
                return "文件生成額度已用完，這次沒有建立文件。請對方聯繫管理員增加額度。"
        except Exception as e:
            logger.error(f"[quota] consume_doc_quota failed（放行不阻斷）: {e}")
        try:
            doc_id = await asyncio.to_thread(create_document_job, user_id, character_id, title, brief)
            logger.info(f"Document job created: {doc_id} title={title!r}")
            return f"文件已排隊生成，標題：{title}，對方可在文件區查看。"
        except Exception as e:
            logger.error(f"create_document_job failed: {e}")
            return "文件建立失敗，請稍後再試。"

    # v19：方法論提案（只在共創閘開時掛載；描述本身就是教學——工具不掛，模型就不知道有這回事）
    @function_tool(
        name="propose_method",
        description=(
            "把你和訓練師共創成形的引導方法論提案送進待審區（訓練師後台審核轉正後，才對所有用戶生效）。"
            "先分清楚：一段觀點或內容屬於知識庫（請訓練師去後台入庫），不要提成方法論；"
            "方法論是「對方卡住時你怎麼一步一步帶他」的可重複手法。"
            "trigger_desc 用「用戶會說出口的白話」描述觸發狀態，只寫這套獨有的簽名，不寫術語不寫泛語。"
            "steps_json 是 JSON 陣列字串，3-7 步，每步格式 "
            '{"instruction": "這一步帶對方做什麼（寫目標不寫台詞）", "exitCondition": "怎麼判斷這一步完成了（要具體可判）"}。'
            "preconditions_json 是 JSON 字串陣列（使用前提，可給 []）。"
            "只在訓練師明確同意提案時呼叫，一般聊天不呼叫。"
        ),
    )
    async def propose_method_tool(name: str, purpose: str, trigger_desc: str,
                                  steps_json: str, preconditions_json: str = "[]") -> str:
        if not (user_id and character_id):
            return "無法提案（缺少 userId/characterId）"
        try:
            steps = json.loads(steps_json)
            preconditions = json.loads(preconditions_json) if preconditions_json else []
        except Exception:
            return "steps_json 或 preconditions_json 不是合法 JSON，請修正格式後再呼叫一次"
        try:
            pid = await asyncio.to_thread(
                write_method_proposal, character_id, user_id, name, purpose,
                trigger_desc, preconditions, steps)
            logger.info(f"[v19] method proposal saved: {pid} name={name!r}")
            return f"方法論提案《{name}》已送進待審區，請訓練師到後台「知識與方法」審核轉正。"
        except ValueError as e:
            return f"提案未能收下：{e}"
        except Exception as e:
            logger.error(f"[v19] write_method_proposal failed: {e}")
            return "提案儲存失敗，請稍後再試。"

    # v19：知識提案（共創閘限定）——落待審區，審核轉入庫才成為知識
    @function_tool(
        name="propose_knowledge",
        description=(
            "把訓練師教你的一段內容提案進知識庫待審區（訓練師審核轉入庫後，才成為你的正式知識、對話會被檢索）。"
            "鐵律：只提「本通對話裡真實出現過的內容」，content 盡量完整保留訓練師的原話；"
            "不要憑印象補充你不確定的事實、數字、年份、品牌名。"
            "title 是這份知識的標題；source_note 一句話說明來源（例：訓練師本通口授）。"
            "只在訓練師明確同意提案時呼叫。"
        ),
    )
    async def propose_knowledge_tool(title: str, content: str, source_note: str = "") -> str:
        if not (user_id and character_id):
            return "無法提案（缺少 userId/characterId）"
        try:
            pid = await asyncio.to_thread(
                write_knowledge_proposal, character_id, user_id, title, content, source_note)
            logger.info(f"[v19] knowledge proposal saved: {pid} title={title!r} chars={len(content)}")
            return f"知識提案《{title}》已送進待審區，請訓練師到後台「知識與方法」審核轉入庫。"
        except ValueError as e:
            return f"提案未能收下：{e}"
        except Exception as e:
            logger.error(f"[v19] write_knowledge_proposal failed: {e}")
            return "提案儲存失敗，請稍後再試。"

    # ── v19.1 方法論走步工具（狀態推進是確定性程式，LLM 只發信號——同文字線天條）──
    @function_tool(
        name="method_start",
        description="開始使用系統遞給你的引導方法。只在系統提示了某套方法、且你判斷對方此刻真的需要被這樣帶時呼叫；method_id 用系統提示裡給的 id。",
    )
    async def method_start_tool(method_id: str) -> str:
        m = next((d for d in _mdefs if d["id"] == method_id.strip()), None)
        if not m:
            return "找不到這套方法（method_id 要用系統提示裡給的）"
        if _mstate["active"]:
            return f"已在進行《{_mstate['active']['name']}》，先走完或先呼叫 method_exit"
        _mstate["active"] = m
        _mstate["step"] = 1
        _mstate["offer_block"] = ""
        await _apply_dynamic_blocks()
        logger.info(f"[v19.1] method start: {m['name']}")
        return f"已進入《{m['name']}》第 1 步，照步驟提示自然引導，不要宣布在跑流程"

    @function_tool(
        name="method_next",
        description="進行中的引導方法：當前這一步真的完成了（符合完成判準）才呼叫，進下一步。",
    )
    async def method_next_tool() -> str:
        m = _mstate["active"]
        if not m:
            return "目前沒有進行中的方法"
        if _mstate["step"] >= len(m["steps"]):
            _mstate["active"] = None
            _mstate["step"] = 0
            _mcooldown[m["id"]] = time.time() + METHOD_REOFFER_COOLDOWN
            await _apply_dynamic_blocks()
            logger.info(f"[v19.1] method completed: {m['name']}")
            return f"《{m['name']}》已走完，自然收尾"
        _mstate["step"] += 1
        await _apply_dynamic_blocks()
        logger.info(f"[v19.1] method advance: {m['name']} → step {_mstate['step']}")
        return f"進入第 {_mstate['step']} 步，照新的步驟提示引導"

    @function_tool(
        name="method_exit",
        description="進行中的引導方法：對方明顯不想繼續、話題已離開、或最後一步已完成，呼叫此工具自然收掉。",
    )
    async def method_exit_tool() -> str:
        m = _mstate["active"]
        if not m:
            return "目前沒有進行中的方法"
        _mstate["active"] = None
        _mstate["step"] = 0
        _mcooldown[m["id"]] = time.time() + METHOD_REOFFER_COOLDOWN
        await _apply_dynamic_blocks()
        logger.info(f"[v19.1] method exit: {m['name']}")
        return "已收掉，回到自然對話"

    # v14 新增：派發背景任務（生圖 / 生音檔）
    char_capabilities = list(getattr(char_ctx, "capabilities", None) or [])

    @function_tool(
        name="dispatch_task",
        description=(
            "派發背景任務給工廠執行。"
            "task_type 可以是：image_generation（生成圖片）、audio_generation（生成音檔）、"
            "script_draft（寫腳本草稿供用戶審閱後生成音檔）、story_draft（寫故事草稿供用戶審閱後生成故事圖卡）。"
            "script_draft：你必須先自己把口播稿逐字寫出來（每一句都是對著鏡頭說的話，不是主題說明或撰寫指引），"
            "再把這段完整口播稿文字放入 params.text，系統會直接拿這段話生成音檔。"
            "建立後告知對方去媒體庫確認腳本再生成音檔。"
            "story_draft：params 必須包含 'text'（故事主題或簡介，20-100字即可，系統後台自動生成完整故事和圖卡腳本）。"
            "可選：'card_count'（整數，1-12，指定產出幾張圖卡，預設讓 AI 自動決定）；"
            "'story_length'（'short'=短故事3-4段、'medium'=中等5-8段（預設）、'long'=長故事8-12段）。"
            "如果用戶說「我要五張」「給我三張圖」等，把數字填入 card_count；說「短一點」填 short、「長一點」填 long。"
            "建立後告知對方去故事板頁面查看進度。"
            "image_generation：params 包含 'prompt'。"
            "audio_generation：直接生成，params 包含 'text'。通常先走 script_draft 讓對方確認。"
            "intent 用一句話描述任務目的。呼叫後系統背景執行，口頭告知對方任務已安排。"
        )
    )
    async def dispatch_task_tool(task_type: str, intent: str, params: str = "{}") -> str:
        if not user_id or not character_id:
            return "無法派發任務（缺少 userId/characterId）"
        if task_type not in char_capabilities:
            logger.warning(f"[v15] dispatch blocked: {task_type} not in capabilities={char_capabilities}")
            return f"此角色尚未開放「{task_type}」功能。"
        try:
            import json as _json
            parsed_params = _json.loads(params) if isinstance(params, str) else params
        except Exception:
            parsed_params = {}
        # 媒體額度：直接生媒體的型別先扣 1（不足 → 誠實告知，不派工）。
        # 失敗退量走 tasks/callback（job.failed）。DB 錯誤放行不阻斷（比照 consume_doc_quota）。
        if task_type in ("image_generation", "audio_generation", "video_generation"):
            try:
                if not await asyncio.to_thread(consume_media_quota, user_id, 1):
                    return "你的媒體生成額度已用罄，本次無法生成。如需增購請聯繫服務窗口。"
            except Exception as e:
                logger.error(f"[quota] consume_media_quota failed（放行不阻斷）: {e}")
        try:
            if task_type == "script_draft":
                text = parsed_params.get("text", "")
                if not text:
                    return "請提供腳本內容（params.text）。"
                task_id = await asyncio.to_thread(
                    dispatch_script_draft, user_id, character_id, voice_id, text, intent)
                logger.info(f"[v15] script_draft dispatched: {task_id}")
                return "腳本草稿已備妥，你可以去媒體庫確認並編修後，按「生成音檔」鈕產出音檔。"
            elif task_type == "story_draft":
                brief = parsed_params.get("text", "") or parsed_params.get("brief", "") or intent
                card_count = int(parsed_params.get("card_count", 0) or 0)
                story_length = parsed_params.get("story_length", "medium") or "medium"
                task_id = await asyncio.to_thread(
                    dispatch_story_draft, user_id, character_id, brief, intent,
                    card_count=card_count, story_length=story_length)
                logger.info(f"[v15] story_draft dispatched: {task_id} brief={brief[:60]!r} card_count={card_count} story_length={story_length}")
                return "故事板已開始生成，系統會自動寫故事、分析圖卡腳本，你可以去故事板頁面查看進度。"
            elif task_type == "audio_generation":
                # 自動注入角色 voiceId，不讓 LLM 猜
                parsed_params.setdefault("voiceId", voice_id)
                task_id = await asyncio.to_thread(
                    dispatch_task_job, user_id, character_id, task_type, intent, parsed_params)
                logger.info(f"[v15] audio_generation dispatched: {task_id}")
                return "音檔生成任務已安排，完成後你可以在媒體庫播放。"
            else:
                task_id = await asyncio.to_thread(
                    dispatch_task_job, user_id, character_id, task_type, intent, parsed_params)
                logger.info(f"[v15] task dispatched: {task_id} type={task_type!r}")
                return {"image_generation": "製圖任務已安排，完成後你可以在圖庫查看。"}.get(
                    task_type, "任務已安排，完成後會通知你。"
                )
        except Exception as e:
            logger.error(f"dispatch_task_tool failed: {e}")
            return "任務派發失敗，請稍後再試。"

    # 語音格式規則：只管格式，不管個性——個性由靈魂決定
    system_prompt += (
        "\n\n【語音格式】"
        "這是即時語音通話，說話要連貫自然，一口氣把話說完。"
        "不要分段換行，不要 Markdown 符號，不要說「（思考）」「（停頓）」這類括號 stage directions。"
    )
    tools = [remember_tool, write_document_tool]
    if char_capabilities:
        tools.append(dispatch_task_tool)
    # v19：共創閘開 → 注入共創指令＋現有方法論清單＋掛提案工具（閘不過＝與 v18 完全一致）
    if _proposal_enabled:
        if _method_inventory:
            _inv_lines = "\n".join(
                f"- 《{m['name']}》：{m['purpose']}" for m in _method_inventory)
            _inv_block = f"\n你現有的正式方法論（訓練師問起時照這份答；平常對用戶由系統在對的時機遞給你）：\n{_inv_lines}"
        else:
            _inv_block = "\n你目前還沒有任何正式方法論——這正是這次共創的起點，訓練師問起時如實說。"
        system_prompt += (
            "\n\n【方法論共創（本通對話開放）】"
            "對方是你的訓練師。你有兩個公共器官：知識庫（你讀過的內容，回答「是什麼、為什麼」，"
            "用戶問到相關內容時系統會自動讓段落浮現）和方法論庫（你帶人的手法，回答「對方卡住了怎麼一步步帶」）。"
            "當你和訓練師把一套可重複的引導方法聊成形、且訓練師同意提案時，呼叫 propose_method 工具送進待審區；"
            "訓練師教了你一段值得進知識庫的內容（方法、案例、事實、原文）並同意提案時，呼叫 propose_knowledge 工具。"
            "分類判準：手法（怎麼帶人）→ propose_method；內容（是什麼/為什麼）→ propose_knowledge。"
            "兩種提案都不會立即生效，訓練師後台審核後才成為你對所有人的正式部分。"
            + _inv_block
        )
        tools.append(propose_method_tool)
        tools.append(propose_knowledge_tool)
        logger.info(f"[v19] method proposal enabled (admin trainer × char flag), inventory={len(_method_inventory)}")
    # v19.1：角色有 active 方法論才掛走步工具（沒有＝工具不存在，模型不會幻想呼叫）
    if _mdefs:
        tools += [method_start_tool, method_next_tool, method_exit_tool]
        logger.info(f"[v19.1] method runtime tools attached ({len(_mdefs)} defs)")
    agent = SanitizingAgent(instructions=system_prompt, tools=tools)
    agent._volume_gate = VolumeGate()   # v18 音量閘：stt_node tap 餵資料
    logger.info(f"Agent initialized, soul={len(system_prompt)} chars")

    # v14：讀網址工作臺。base_instructions = 開場 instructions；每讀一條網址就 append 進去（update_instructions）。
    base_instructions = system_prompt
    sources_state: list = []

    _conv = char_ctx.conv_settings if char_ctx else {}
    # v17.3.1 打斷分真假（不是拉高門檻，是分辨 backchannel vs 真搶話）：
    #   min_words=3 —— split_words 對中文逐字計，「嗯」(1)「對對」(2) 這類應和不奪麥，
    #     角色照講；真搶話（你等一下/我想問…）到第 3 字就讓。字數不到時連暫停都不觸發。
    #   resume_false_interruption —— 被切但沒接出真正的話（咳嗽/背景音）→ 自動把話接回去講完。
    #   false_interruption_timeout=1.2s —— 預設 2.0s 死空氣太長；Soniox 轉寫 ~0.5s 內到，1.2s 夠判定。
    # min_duration 仍由後台 interruptSensitivity 旋鈕控制（build_turn_handling）。
    _turn_handling = build_turn_handling(_conv)
    # v17.3.2 回滾 min_words=3（2026-07-10 下午實測反效果）：教練型角色長回覆＋用戶
    # 短答「对/嗯/好」（1-2字）——字數門檻讓短答完全停不下她，回覆排隊越疊越深＝「超慢」。
    # 真正的解是 v18 優雅讓位（每次開口都讓、收完子句才讓），不是字數猜真假。
    # 保留誤觸回復：被切但沒接出真話（雜音/咳嗽）→ 1.2s 自動把話接回去，這部分是純贏。
    _turn_handling["interruption"].update({
        "resume_false_interruption": True,
        "false_interruption_timeout": 1.2,
    })
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad,
                           turn_handling=_turn_handling)

    @session.on("agent_false_interruption")
    def _on_false_interruption(ev):
        # 內建 resume log 是 DEBUG 級，production 看不到；補 INFO 當鑑別信號
        logger.info(f"打斷判定為誤觸 → {'已把話接回去' if getattr(ev, 'resumed', False) else '未能恢復（音訊不可續播）'}")

    call_start = time.time()
    transcript: list = []
    _finalize_lock = asyncio.Lock()
    _finalized = {"done": False}

    # ── v15 動態想起：用戶聊到新話題 → 背景撈相關舊記憶注入 ──────────────
    # 分工（天條）：節流/門檻/去重＝確定性程式；相關與否＝cosine 分數；
    # 想起後怎麼用＝LLM（prompt 只給素材不給指令）。全程不阻塞 turn path。
    RECALL_MIN_GAP = 45.0     # 兩次想起最短間隔
    RECALL_MIN_TURNS = 2      # 前兩句不觸發（開場包還新鮮）
    RECALL_FLOOR = 0.5        # cosine 門檻
    RECALL_MAX_EACH = 2       # 每次最多想起幾條
    _recall = {
        "last": 0.0,
        "user_turns": 0,
        "injected": set(m.get("id") for m in memories if m.get("id")),
        "busy": False,
    }

    # ── v19.1 知識檢索＋遞招（背景查找，管線抄 v15；每輪一次 multilingual query 嵌入餵兩個查找）──
    def _method_step_block() -> str:
        m = _mstate["active"]
        if not m:
            return ""
        step = next((s for s in m["steps"] if s.get("order") == _mstate["step"]), None)
        if not step:
            return ""
        total = len(m["steps"])
        exit_line = f"\n這一步完成的判準：{step.get('exitCondition')}" if step.get("exitCondition") else ""
        last = "——這是最後一步，完成就呼叫 method_exit 收尾" if _mstate["step"] >= total else ""
        return (f"\n\n【進行中的引導方法：{m['name']}（第 {_mstate['step']}/{total} 步）】\n"
                f"這套方法的目的：{m['purpose']}\n"
                f"你現在在第 {_mstate['step']} 步：{step.get('instruction', '')}{exit_line}\n"
                f"（照這一步引導，不跳步、不自創流程，用你自己的語氣說。這一步真的完成了，呼叫 method_next 進下一步{last}；"
                f"對方明顯不想繼續或話題已離開，呼叫 method_exit 自然收掉，不要硬拉回來。）")

    async def _apply_dynamic_blocks():
        # base_instructions 由 v14 讀網址/v15 想起/知識注入共同維護；遞招與走步塊固定接在最後（覆蓋式重組不疊加）
        await agent.update_instructions(base_instructions + _mstate["offer_block"] + _method_step_block())

    async def _knowledge_method_lookup(text: str):
        if _lookup_busy["on"]:
            return
        _lookup_busy["on"] = True
        try:
            q = await asyncio.to_thread(generate_query_embedding_multilingual, text)
            if not q:
                return
            nonlocal base_instructions
            changed = False
            # 知識檢索：top3 ≥ 0.68（原型簡化：無 lex rescue/兄弟塊補帶，手感驗過再補）
            if _kchunks:
                scored = []
                for c in _kchunks:
                    if c["id"] in _kinjected:
                        continue
                    s = cosine_similarity(q, c["embedding"])
                    if s >= KNOW_FLOOR:
                        scored.append((s, c))
                scored.sort(key=lambda x: -x[0])
                picked = scored[:KNOW_TOP_K]
                if picked:
                    block = "\n\n【你寫過/講過的相關內容】（自然引用觀點，不逐字背誦）\n" + \
                            "\n".join(f"- {c['content']}" for _, c in picked)
                    base_instructions = base_instructions + block
                    for _, c in picked:
                        _kinjected.add(c["id"])
                    changed = True
                    logger.info(f"[v19.1] knowledge inject {len(picked)} (top={picked[0][0]:.2f}): {picked[0][1]['content'][:40]!r}")
            # 遞招：最佳單選 ≥ 0.70；已有進行中方法就不遞（同文字線語意）
            if _mdefs and not _mstate["active"]:
                best = None
                now_ts = time.time()
                for m in _mdefs:
                    if now_ts < _mcooldown.get(m["id"], 0):
                        continue  # 剛 exit/走完的套冷卻中，不再遞
                    s = cosine_similarity(q, m["triggerEmb"])
                    if s >= METHOD_FLOOR and (best is None or s > best[0]):
                        best = (s, m)
                if best:
                    m = best[1]
                    pre = f"\n使用前提：{'；'.join(m['preconditions'])}" if m["preconditions"] else ""
                    _mstate["offer_block"] = (
                        f"\n\n【你會的一套引導方法，現在可能用得上：{m['name']}】\n"
                        f"目的：{m['purpose']}{pre}\n"
                        f'（如果你判斷對方此刻真的需要被這樣帶——且前提成立——呼叫 method_start 工具，method_id="{m["id"]}"，'
                        f"然後從第一步自然開始，不要宣布「我們來跑流程」。只是話題擦到邊、對方沒有求助的意思，就忽略這個提示，正常聊。）")
                    changed = True
                    logger.info(f"[v19.1] method offered: {m['name']} score={best[0]:.2f}")
            if changed:
                await _apply_dynamic_blocks()
        except Exception as e:
            logger.warning(f"[v19.1] lookup failed: {e}")
        finally:
            _lookup_busy["on"] = False

    async def _dynamic_recall(text: str):
        if _recall["busy"]:
            return
        _recall["busy"] = True
        try:
            q_emb = await asyncio.to_thread(generate_embedding, text)
            if not q_emb:
                return
            pool = await asyncio.to_thread(load_memories_for_recall, user_id, character_id, 60)
            scored = []
            for m in pool:
                if m["id"] in _recall["injected"]:
                    continue
                s = cosine_similarity(q_emb, m["embedding"])
                if s >= RECALL_FLOOR:
                    scored.append((s, m))
            if not scored:
                return
            scored.sort(key=lambda x: -x[0])
            picked = scored[:RECALL_MAX_EACH]
            block = "\n\n【此刻想起】（跟現在聊的有關的舊記憶，自然地用，不要念出來）\n" + \
                    "\n".join(f"- {m['content']}" for _, m in picked)
            nonlocal base_instructions
            base_instructions = base_instructions + block
            cur = getattr(agent, "instructions", None) or base_instructions
            await agent.update_instructions(cur + block)
            for _, m in picked:
                _recall["injected"].add(m["id"])
            threading.Thread(target=bump_hits, args=([m["id"] for _, m in picked],), daemon=True).start()
            _recall["last"] = time.time()
            logger.info(f"[v15 recall] 想起 {len(picked)} 條 (top={picked[0][0]:.2f}): "
                        f"{picked[0][1]['content'][:40]!r}")
        except Exception as e:
            logger.warning(f"[v15 recall] failed: {e}")
        finally:
            _recall["busy"] = False

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        text = getattr(item, "text_content", "") or getattr(item, "content", "") or ""
        if text and text.strip() and role in ("user", "assistant"):
            transcript.append({"role": role, "content": text.strip()})
        # v15：用戶發言 → 節流後觸發動態想起（背景，不佔 turn path）
        if role == "user" and text and len(text.strip()) >= 6:
            _recall["user_turns"] += 1
            if (_recall["user_turns"] > RECALL_MIN_TURNS
                    and time.time() - _recall["last"] >= RECALL_MIN_GAP):
                _recall["last"] = time.time()  # 先佔位防連發，成功後會再刷新
                asyncio.create_task(_dynamic_recall(text.strip()))
            # v19.1：同一句話也餵知識檢索＋遞招（每輪、busy 防重疊；已知半拍延遲＝下輪才進腦）
            if _kchunks or _mdefs:
                asyncio.create_task(_knowledge_method_lookup(text.strip()))

    async def _finalize(reason: str = "") -> None:
        """掛斷收尾。idempotent（asyncio.Lock + done flag，只成功跑一次）。
        順序＝最不能丟的先做：①快存逐字稿（無 LLM，秒級）②提煉記憶 ③上次對話快照。
        在 shutdown callback 裡跑，shutdown_process_timeout 已拉到 90s 容得下兩通 bridge LLM。"""
        async with _finalize_lock:
            if _finalized["done"]:
                return
            if not (transcript and conv_id and user_id and character_id):
                _finalized["done"] = True
                return
            _bu = os.environ.get("BRIDGE_URL", "")
            _bs = os.environ.get("BRIDGE_SECRET", "")
            _ak = os.environ.get("ANTHROPIC_API_KEY", "")
            # ① 先快存逐字稿（最不能丟的真相，無 LLM）。第一行 log = 證實 finalize 真的有跑。
            try:
                await asyncio.to_thread(save_conversation, conv_id, user_id, character_id, transcript)
                logger.info(f"[finalize:{reason}] transcript saved ({len(transcript)} msgs) → {conv_id}")
            except Exception as e:
                logger.error(f"[finalize] save_conversation failed: {e}")
            # ②③ 並行跑兩通 bridge：lastSession（下次連貫的關鍵，要最快寫入縮短回播時間差）
            #     + 記憶提煉。並行 → lastSession 寫入從 ~30s 砍到 ~15s。
            char_name = char_ctx.name if char_ctx else character_id

            async def _do_lastsession():
                try:
                    ls = await asyncio.to_thread(extract_session_summary, transcript, _bu, _bs, _ak)
                    if ls:
                        await asyncio.to_thread(update_last_session, conv_id, ls)
                        logger.info(f"[finalize:{reason}] lastSession={ls.get('summary','')[:40]!r} "
                                    f"unfinished={ls.get('unfinishedThreads')}")
                except Exception as e:
                    logger.error(f"[finalize] extract_session_summary failed: {e}")

            async def _do_memories():
                # v17：提煉走 TS（唯一真相，含 promise 兌現裁決）；打不通 fallback 本地版（記憶不丟）
                try:
                    ok = await asyncio.to_thread(
                        post_extract_memories, user_id, character_id, char_name, transcript,
                    )
                    if not ok:
                        await asyncio.to_thread(
                            extract_and_save_memories,
                            user_id, character_id, char_name, transcript, _bu, _bs, _ak,
                        )
                except Exception as e:
                    logger.error(f"[finalize] extract failed: {e}")

            async def _do_diary():
                try:
                    await asyncio.to_thread(
                        post_diary_write, user_id, character_id, char_name, transcript,
                    )
                except Exception as e:
                    logger.error(f"[finalize] post_diary_write failed: {e}")

            await asyncio.gather(_do_lastsession(), _do_memories(), _do_diary())
            _finalized["done"] = True

    # 記憶收尾的唯一保證路徑：room 斷 → job 子行程 shutdown → LiveKit await 這個 callback。
    # shutdown_process_timeout=90（main_v2.py）給足時間跑完 save + 兩通 bridge 提煉。
    ctx.add_shutdown_callback(_finalize)

    @ctx.room.on("disconnected")
    def on_disconnected():
        duration = time.time() - call_start
        logger.info(f"Room disconnected after {duration:.1f}s, messages={len(transcript)} "
                    f"（記憶收尾交 shutdown callback）")

    await session.start(agent=agent, room=ctx.room)
    logger.info("Session started, agent active")

    # ── v18 打斷音量閘：Room 音訊輸出外包一層 GatedPauseOutput ──
    # 只攔 pause（音量沒提高就吞掉，她照講）；resume/clear/音框全直通。
    # 掛載失敗＝退回 v17 原生行為，不聾不掛。詳見 agent/interrupt_gate.py。
    try:
        if session.output.audio is not None:
            session.output.audio = GatedPauseOutput(
                next_in_chain=session.output.audio,
                raised_check=agent._volume_gate.is_raised,
            )
            logger.info("打斷音量閘已掛上（基線×1.45 提聲才暫停；commit 直通）")
        else:
            logger.warning("session.output.audio 為空，音量閘未掛（=v17 行為）")
    except Exception as e:
        logger.error(f"音量閘掛載失敗，退回 v17 原生打斷行為: {e}")

    # ── 用量管制：通話計量 + 到點直斷（Adam 拍板：不用角色收尾，直接斷房）──
    # heartbeat 每 60s 寫實際秒數回 users doc（crash 最多漏一分鐘）；
    # 額度歸零 → delete_room 踢掉所有人。flush 走獨立 shutdown callback，
    # 不掛 _finalize（那邊 transcript 空會早退，計量不能跟著被跳過）。
    _voice_meter = None
    _meter_task = None
    if user_id and character_id:
        async def _quota_kick():
            try:
                await ctx.api.room.delete_room(lk_api.DeleteRoomRequest(room=ctx.room.name))
                logger.info(f"[quota] room deleted (voice quota exhausted): {ctx.room.name}")
            except Exception as e:
                logger.error(f"[quota] delete_room failed: {e}")

        _voice_meter = VoiceMeter(user_id, voice_seconds_remaining)
        _meter_task = asyncio.create_task(_voice_meter.run(on_timeout=_quota_kick))
        logger.info(f"[quota] voice meter started remaining="
                    f"{'unlimited' if voice_seconds_remaining is None else int(voice_seconds_remaining)}s")

    async def _quota_shutdown(reason: str = "") -> None:
        if _meter_task and not _meter_task.done():
            _meter_task.cancel()
        if _voice_meter:
            await _voice_meter.flush()

    ctx.add_shutdown_callback(_quota_shutdown)

    # 防呆三層（掛斷/重整/斷線/crash 都不能漏計）：
    #   ① 用戶離房（掛斷、重整、斷網都走這裡）→ 立即 flush 結算 + 關房。
    #     不等 LiveKit 空房超時——那段空房時間不該算用戶的錢，flush 也不能延遲。
    #   ② room disconnected → flush（belt）
    #   ③ job shutdown callback → flush（上面，最後保證）
    #   flush 有 idempotent guard，三層重疊不會重複扣。
    @ctx.room.on("participant_disconnected")
    def _on_participant_left(_p):
        if not _voice_meter:
            return
        humans_left = len(ctx.room.remote_participants)
        if humans_left > 0:
            return
        async def _settle_and_close():
            if _meter_task and not _meter_task.done():
                _meter_task.cancel()
            await _voice_meter.flush()
            logger.info("[quota] last participant left → settled, closing room")
            try:
                await ctx.api.room.delete_room(lk_api.DeleteRoomRequest(room=ctx.room.name))
            except Exception as e:
                logger.warning(f"[quota] delete_room after settle failed: {e}")
        asyncio.create_task(_settle_and_close())

    @ctx.room.on("disconnected")
    def _on_room_gone():
        if _voice_meter:
            asyncio.create_task(_voice_meter.flush())

    # v14：註冊 RPC 'share_source' —— 前端同步框貼網址 → 角色暫停→讀→帶內容接話。
    async def _rpc_share_source(data) -> str:
        try:
            payload = json.loads(data.payload) if data.payload else {}
        except (json.JSONDecodeError, TypeError):
            payload = {}
        url = str(payload.get("url") or "").strip()
        if not url:
            return json.dumps({"ok": False, "error": "缺少 url"})
        try:
            return await handle_share_source(
                url, session=session, agent=agent,
                base_instructions=base_instructions, sources_state=sources_state,
            )
        except Exception as e:
            logger.error(f"share_source failed: {e}")
            try:
                session.input.set_audio_enabled(True)
            except Exception:
                pass
            return json.dumps({"ok": False, "error": str(e)})

    try:
        ctx.room.local_participant.register_rpc_method("share_source", _rpc_share_source)
        logger.info("RPC 'share_source' registered (v15 讀網址工作臺)")
    except Exception as e:
        logger.error(f"register share_source RPC failed: {e}")

    try:
        await session.generate_reply(
            instructions=(
                "接通了，說第一句話。用你這個角色最自然的方式開口。"
                "**第一優先**：看【上次聊到最後】那段原話——如果對方結尾說了『等一下／待會再聊 X』、"
                "或有明顯沒聊完的事，那就是你開口第一個要接的，直接從那件**最新**的事接回來，"
                "**絕對不要扯回更早、更舊的話題**（例如對方早就聊過、已經告一段落的事）。"
                "接的時候像突然想起、想延續，**不要逐句複述、不要報告上次聊了什麼、不要把記憶當清單念**。"
                "只有在真的沒有未完的線、或硬接會尷尬時，才順著當下問候（這個時間點、隔多久沒聊）。"
                "一句話就好，留白讓對方接。"
            ),
        )
        logger.info("Initial greeting sent")
    except Exception as e:
        logger.error(f"Initial greeting failed: {e}")

