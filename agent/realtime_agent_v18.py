"""
ailivex-realtime-agent v18 — LiveKit Agent 核心邏輯（= v17 + 優雅讓位 graceful yield）

v17 差異：被打斷時不再瞬間靜音——BoundaryAwareAudioOutput（agent/graceful_yield.py）
把 pause/clear 延遲到下一個音訊能量谷（子句邊界，上限 1.8s）才執行，讓位期音量漸降；
誤觸（咳嗽/應和）在到達邊界前 resume ＝ 她根本沒停過。被真打斷的句子在 chat_ctx
標記「沒說完」，下一句帶讓位意識接話。

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
import random
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
from agent.graceful_yield import BoundaryAwareAudioOutput
from agent.conv_tuning import (
    build_turn_handling, get_im_threshold, get_temperature,
    is_farewell, is_semantic_repeat,
)
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
    釘在 chat_ctx → Anthropic 的咽喉，所有 generate_reply 都受保護。"""
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
        kept.append(it)
    items[:] = kept

    try:
        msgs, _ = chat_ctx.to_provider_format(format="anthropic")
        if msgs and msgs[-1].get("role") == "assistant":
            chat_ctx.add_message(role="user", content=["(empty)"])
    except Exception as e:
        logger.warning(f"_sanitize_chat_ctx trailing-assistant guard skipped: {e}")


class SanitizingAgent(Agent):
    async def llm_node(self, chat_ctx, tools, model_settings):
        _sanitize_chat_ctx(chat_ctx)
        # v18 被打斷標記（one-shot）：上一句被真打斷 → 在那則 assistant 訊息尾端
        # 注明沒說完，讓下一句有讓位意識（要不要接回沒說完的，由角色個性決定）。
        gy = getattr(self, "_graceful_yield", None)
        if gy is not None and gy.interrupt_state.get("cut"):
            gy.interrupt_state["cut"] = False
            try:
                for it in reversed(chat_ctx.items):
                    if type(it).__name__ == "ChatMessage" and getattr(it, "role", "") == "assistant":
                        c = getattr(it, "content", None)
                        if isinstance(c, list) and c and isinstance(c[-1], str):
                            c[-1] = c[-1] + "……（這句被對方打斷，沒說完）"
                        break
            except Exception as e:
                logger.warning(f"被打斷標記注入失敗（略過）: {e}")
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk


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
            logger.info(f"[v17] remote_blocks={'hit' if _remote_blocks else 'fallback-local'}")
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
    agent = SanitizingAgent(instructions=system_prompt, tools=tools)
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
    _turn_handling["interruption"].update({
        "min_words": 3,
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
    # v16.2: 3a 停止鉤子——自我重排 timer 必綁 lifecycle 停止條件（v6-v10 斷線空轉家族雷）。
    # 3a 區塊在後段初始化後填入真身；在那之前斷線，呼叫 no-op 安全。
    _stop_3a = {"fn": lambda: None}

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

    async def _finalize(reason: str = "") -> None:
        """掛斷收尾。idempotent（asyncio.Lock + done flag，只成功跑一次）。
        順序＝最不能丟的先做：①快存逐字稿（無 LLM，秒級）②提煉記憶 ③上次對話快照。
        在 shutdown callback 裡跑，shutdown_process_timeout 已拉到 90s 容得下兩通 bridge LLM。"""
        _stop_3a["fn"]()   # v16.2: 收尾第一件事＝停 3a，不再對空房評估/發話
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

    # ── v18 優雅讓位：把 Room 音訊輸出包進 BoundaryAwareAudioOutput ──
    # 框架的 pause/clear 都打在這層代理上：撐到子句邊界（音訊能量谷）才真的停，
    # 讓位期音量漸降；誤觸在邊界前 resume ＝ 她根本沒停過。詳見 agent/graceful_yield.py。
    try:
        if session.output.audio is not None:
            _gy = BoundaryAwareAudioOutput(next_in_chain=session.output.audio)
            session.output.audio = _gy
            agent._graceful_yield = _gy   # llm_node 讀 interrupt_state 標記「被打斷沒說完」
            logger.info("優雅讓位層已掛上（LEAD=0.35s, 邊界=靜音谷≥120ms, 保底=1.8s, duck→0.55）")
        else:
            logger.warning("session.output.audio 為空，優雅讓位層未掛")
    except Exception as e:
        logger.error(f"優雅讓位層掛載失敗，退回原生打斷行為: {e}")

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
        if len(ctx.room.remote_participants) == 0:
            _stop_3a["fn"]()   # v16.2: 人走光 → 3a 停
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
        _stop_3a["fn"]()   # v16.2: 房間斷 → 3a 停
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

    # ── 3a 主動發話：擬真 backoff + 抖動 + 情境化判斷（v3 第二口蛋糕）──
    # 分工（天條）：節奏(backoff/抖動/間隔保護)＝確定性程式；開不開口＋說什麼＝LLM 看脈絡判斷；
    # baseline 快慢＝soul 的 imThreshold。被晾著越久間隔越拉長、語氣越退，像真人逐漸給空間，
    # 用戶一開口就整個歸零、重新變得很在線。
    im_threshold = get_im_threshold(_conv)               # 1-5，越高越主動
    # v18：3a 是輔助系統，不該主動介入太多（Adam 2026-07-10 拍板）。起手間隔調到
    # 「真正冷場才出手」級：im1→15s im2→12s im3→9s im4→6s im5→6s（原 2-4.5s 太搶話）。
    # 配合 v16.5 靜默起點對齊（角色說完才起算），這是真實靜默秒數。
    baseline_secs = max(6.0, 18.0 - im_threshold * 3.0)
    BACKOFF = 2.1            # 每戳一次沒回應，下次間隔 ×這個（退讓）
    MAX_INTERVAL = 120.0     # 間隔上限：最久約兩分鐘才探一次
    JITTER = 0.25            # ±25% 有界抖動（不是純亂數，去機械感）
    MIN_GAP = 8.0            # 兩次主動發話最短間隔保護
    _itj = {"timer": None, "interval": baseline_secs, "nudges": 0, "last_say": 0.0,
            "quiet_since": time.time(), "stopped": False}

    def _cancel_timer():
        if _itj["timer"] is not None:
            _itj["timer"].cancel()
            _itj["timer"] = None

    def _stop_interject():
        if not _itj["stopped"]:
            logger.info("3a: lifecycle 停止（房間收尾）")
        _itj["stopped"] = True
        _cancel_timer()

    _stop_3a["fn"] = _stop_interject

    def _arm(interval: float):
        if _itj["stopped"]:
            return
        _cancel_timer()
        jittered = max(1.0, interval * (1.0 + random.uniform(-JITTER, JITTER)))
        loop = asyncio.get_running_loop()
        _itj["timer"] = loop.call_later(jittered, lambda: asyncio.create_task(_maybe_interject()))

    async def _maybe_interject():
        _itj["timer"] = None
        if _itj["stopped"]:
            return
        # gate：不蓋過人、自己沒在說 → 稍後再看，不算一次 nudge
        if session.current_speech is not None or getattr(session, "agent_state", "") == "speaking":
            _arm(2.5)
            return
        if time.time() - _itj["last_say"] < MIN_GAP:
            _arm(MIN_GAP)
            return
        # v16.5 道別待命：雙方最後一句都是道別 → 停止自我重排，不再對「掛斷前的沉默」開口。
        # 用戶再開口會經 _on_user_state（speaking 歸零 → listening 補種 timer）自動復活。
        try:
            _last_user = next((t["content"] for t in reversed(transcript) if t["role"] == "user"), "")
            _last_asst = next((t["content"] for t in reversed(transcript) if t["role"] == "assistant"), "")
            if _last_user and _last_asst and is_farewell(_last_user) and is_farewell(_last_asst):
                logger.info("3a: 道別待命（雙方已互道再見，停止主動發話；用戶再開口即復活）")
                return
        except Exception as e:
            logger.warning(f"3a farewell check failed: {e}")
        quiet_for = int(time.time() - _itj["quiet_since"])
        n = _itj["nudges"]
        logger.info(f"3a: 評估主動開口 (第{n+1}次, 已靜默{quiet_for}s, interval={_itj['interval']:.0f}s, im={im_threshold})")
        try:
            from anthropic import AsyncAnthropic
            recent = "\n".join(f"{t['role']}: {t['content']}" for t in transcript[-6:]) or "（還沒有對話）"
            _bu = os.environ.get("BRIDGE_URL", "")
            _bs = os.environ.get("BRIDGE_SECRET", "")
            if _bu and _bs:
                _client = AsyncAnthropic(api_key=_bs, base_url=_bu)   # 走 Bridge 吃 Max
                _model = "claude-sonnet-4-6"
            else:
                _client = AsyncAnthropic(api_key=anthropic_key)
                _model = "claude-haiku-4-5-20251001"
            resp = await _client.messages.create(
                model=_model,
                max_tokens=80,
                system=system_prompt + (
                    "\n\n[主動性·此刻是否開口] 對方沉默了。以你這個角色的本性判斷——"
                    "此刻你心裡有沒有什麼念頭真的自然地想說出來？"
                    "沉默很多時候才是對的，不要為了填空間而開口。"
                    "如果你是沉思型、會讓話沉澱的角色，沉默就是答案。"
                ),
                messages=[{"role": "user", "content": (
                    f"最近的對話（逐字）：\n{recent}\n\n"
                    f"狀況：已經安靜約 {quiet_for} 秒，你已主動開口 {n} 次、對方都還沒回。\n"
                    "以你這個角色的本性，判斷此刻要不要開口。\n\n"
                    "若開口——這句話必須是你此刻真實浮現的念頭：\n"
                    "・接住對方剛說、還沒聊完的某個點，說出你此刻真實的反應或感受；\n"
                    "・帶你這個角色獨有的語氣和視角，是『只有你會這樣說』的話，不是任何角色都能講的通用句；\n"
                    "・可以是一個觀察、一個反應、一句從你的個性自然長出來的話；\n"
                    "・問題只有在你這個角色的本性就是會問的情況下才自然，不要為了推動對話而問。\n"
                    "嚴禁通用罐頭問候——『在嗎／還在嗎／你還好嗎／有在聽嗎／怎麼不說話了』一律不准。\n"
                    "被晾越久語氣越淡、越收，或乾脆保持沉默。\n\n"
                    "只輸出那一句話本身；若沉默才自然，就輸出空字串，什麼都別寫。"
                )}],
            )
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
            text = text.strip("（）()「」\"' ")
            if text and text not in ("沉默", "NOTHING", "無", "空", "（沉默）"):
                # v16.5 去重防護：跟角色最近說過的話語意重複 → 擋下不說（機制保證，不靠 prompt 自律）。
                # 治「回合路剛回完，3a 把同一句換個皮再說一次」的兩張嘴打架。
                _recent_asst = [t["content"] for t in transcript if t["role"] == "assistant"][-3:]
                if is_semantic_repeat(text, _recent_asst):
                    logger.info(f"3a: 去重擋下(第{n+1}次)（與剛說過的話重複）→ {text[:60]!r}")
                else:
                    logger.info(f"3a: 主動說(第{n+1}次) → {text[:60]!r}")
                    session.say(text)   # 走 MiniMax TTS（內含 opencc 繁→簡）
                    _itj["last_say"] = time.time()
            else:
                logger.info(f"3a: 評估後選擇沉默(第{n+1}次)")
        except Exception as e:
            logger.error(f"3a interject failed: {e}")
        # backoff：對方還沒回（用戶開口會在 _on_user_state 歸零），間隔越拉越長、自我重排持續探
        _itj["nudges"] += 1
        _itj["interval"] = min(_itj["interval"] * BACKOFF, MAX_INTERVAL)
        _arm(_itj["interval"])

    @session.on("user_state_changed")
    def _on_user_state(ev):
        new = getattr(ev, "new_state", "")
        if new == "speaking":
            # 用戶開口＝一切歸零，重新很在線
            _cancel_timer()
            _itj["interval"] = baseline_secs
            _itj["nudges"] = 0
            _itj["quiet_since"] = time.time()
            if getattr(session, "agent_state", "") == "speaking":
                logger.info("3a: 用戶在角色說話時插話 → 讓位（被打斷回饋）")
        elif new == "listening":
            # 回合邊界＝一段新靜默的起點。沒有 pending timer 才種一個（避免和自我重排打架）
            if _itj["nudges"] == 0:
                _itj["quiet_since"] = time.time()
            if _itj["timer"] is None:
                _arm(_itj["interval"])

    @session.on("agent_state_changed")
    def _on_agent_state(ev):
        # v16.5 靜默起點對齊：角色說完話（回合回覆或 3a 自己）才是這段靜默的起點。
        # 原本從用戶最後一句起算，角色講話的時間也被算進「已靜默」→ 判斷 LLM 高估冷場，
        # 回合路剛回完幾秒 3a 就想接自己的話。
        if getattr(ev, "new_state", "") == "listening":
            _itj["quiet_since"] = time.time()

    logger.info(f"3a active(擬真backoff): baseline={baseline_secs:.1f}s ×{BACKOFF} cap={MAX_INTERVAL:.0f}s im={im_threshold}")
