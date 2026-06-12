"""
ailivex-realtime-agent — LiveKit Agent 核心邏輯

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
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv
load_dotenv(ROOT_DIR / ".env")

from livekit.agents import Agent, AgentSession, JobContext, function_tool
from livekit.plugins import silero, anthropic, soniox
from agent.minimax_tts import MiniMaxCustomTTS
from agent.conv_tuning import build_turn_handling, get_im_threshold, get_temperature
from agent.firestore_loader import (
    load_character,
    load_conversation,
    load_memories,
    load_relationship,
    save_conversation,
    write_memory,
    build_system_prompt,
    extract_and_save_memories,
    extract_session_summary,
    update_last_session,
    create_document_job,
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("ailivex-realtime-v3")

PROJECT_NAMESPACE = os.environ.get("PROJECT_NAMESPACE", "ailivex")

FALLBACK_PROMPT = (
    "你是一個禮貌的 AI 助手。這是即時語音通話。"
    "用簡體中文回覆（TTS 發音穩定），一兩句話，不要 stage directions。"
)


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

    system_prompt = FALLBACK_PROMPT
    char_ctx = None
    conv_ctx = None

    if character_id:
        try:
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

            system_prompt = build_system_prompt(
                char_ctx, conv_ctx or _EmptyConv(), memories, relationship=relationship
            )
            logger.info(
                f"Loaded character={char_ctx.name} id={character_id} "
                f"soul_chars={len(char_ctx.soul_text)} memories={len(memories)} "
                f"voice={char_ctx.voice_id_minimax or '(default)'}"
            )
        except Exception as e:
            logger.error(f"Firestore load failed, using fallback: {e}")

    await ctx.connect()
    logger.info("Connected to room, waiting for participant...")
    participant = await ctx.wait_for_participant()
    logger.info(f"Participant joined: {participant.identity}")

    vad = silero.VAD.load(
        min_silence_duration=0.4,
        prefix_padding_duration=0.3,
        min_speech_duration=0.1,
        activation_threshold=0.5,
    )

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
        speed=speed,
        pitch=pitch,
        vol=vol,
        emotion=emotion,
    )

    @function_tool(name="remember", description="把重要的事記住，供下次對話回憶")
    async def remember_tool(content: str) -> str:
        if user_id and character_id:
            mem_id = write_memory(user_id, character_id, content, source="voice")
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
        try:
            doc_id = create_document_job(user_id, character_id, title, brief)
            logger.info(f"Document job created: {doc_id} title={title!r}")
            return f"文件已排隊生成，標題：{title}，對方可在文件區查看。"
        except Exception as e:
            logger.error(f"create_document_job failed: {e}")
            return "文件建立失敗，請稍後再試。"

    # v2 深度版：深度靠「真的在聽」，但口氣要平實，別演
    system_prompt += (
        "\n\n【在場與口氣】"
        "真的在聽對方說什麼，聽出話裡的情緒和潛台詞——但用最平實、內斂、口語的方式回應，"
        "像私下跟老朋友隨口閒聊。不要說法、不要開示、不要金句、不要戲劇化或拖長的語氣。"
        "深刻的東西用最普通的話帶過，越不費力越自然。不確定就誠實，不要客套、不要 AI 腔、不要演。"
        "這是即時語音，一口氣自然把話說完，**不要分段、不要空行、不要換行**，像講話不是寫字。"
    )
    agent = Agent(instructions=system_prompt, tools=[remember_tool, write_document_tool])
    logger.info(f"Agent initialized, soul={len(system_prompt)} chars")

    _conv = char_ctx.conv_settings if char_ctx else {}
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad,
                           turn_handling=build_turn_handling(_conv))

    call_start = time.time()
    transcript: list = []
    _finalize_lock = asyncio.Lock()
    _finalized = {"done": False}

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        text = getattr(item, "text_content", "") or getattr(item, "content", "") or ""
        if text and text.strip() and role in ("user", "assistant"):
            transcript.append({"role": role, "content": text.strip()})

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
                try:
                    await asyncio.to_thread(
                        extract_and_save_memories,
                        user_id, character_id, char_name, transcript, _bu, _bs, _ak,
                    )
                except Exception as e:
                    logger.error(f"[finalize] extract_and_save_memories failed: {e}")

            await asyncio.gather(_do_lastsession(), _do_memories())
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

    try:
        await session.generate_reply(
            instructions=(
                "接通了，說第一句話。像老朋友重新接上線那樣自然開口。"
                "**第一優先**：看【上次聊到最後】那段原話——如果對方結尾說了『等一下／待會再聊 X』、"
                "或有明顯沒聊完的事，那就是你開口第一個要接的，直接從那件**最新**的事接回來，"
                "**絕對不要扯回更早、更舊的話題**（例如對方早就聊過、已經告一段落的事）。"
                "接的時候像突然想起、想延續，**不要逐句複述、不要報告上次聊了什麼、不要把記憶當清單念**。"
                "只有在真的沒有未完的線、或硬接會尷尬時，才順著當下問候（這個時間點、隔多久沒聊）。"
                "一句話就好，口氣平實，留白讓對方接。"
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
    baseline_secs = max(2.0, 4.5 - im_threshold * 0.5)   # im1→4.0s … im5→2.0s：起手多快開口
    BACKOFF = 2.1            # 每戳一次沒回應，下次間隔 ×這個（退讓）
    MAX_INTERVAL = 120.0     # 間隔上限：最久約兩分鐘才探一次
    JITTER = 0.25            # ±25% 有界抖動（不是純亂數，去機械感）
    MIN_GAP = 8.0            # 兩次主動發話最短間隔保護
    _itj = {"timer": None, "interval": baseline_secs, "nudges": 0, "last_say": 0.0, "quiet_since": time.time()}

    def _cancel_timer():
        if _itj["timer"] is not None:
            _itj["timer"].cancel()
            _itj["timer"] = None

    def _arm(interval: float):
        _cancel_timer()
        jittered = max(1.0, interval * (1.0 + random.uniform(-JITTER, JITTER)))
        loop = asyncio.get_running_loop()
        _itj["timer"] = loop.call_later(jittered, lambda: asyncio.create_task(_maybe_interject()))

    async def _maybe_interject():
        _itj["timer"] = None
        # gate：不蓋過人、自己沒在說 → 稍後再看，不算一次 nudge
        if session.current_speech is not None or getattr(session, "agent_state", "") == "speaking":
            _arm(2.5)
            return
        if time.time() - _itj["last_say"] < MIN_GAP:
            _arm(MIN_GAP)
            return
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
                    "\n\n[主動性判斷] 對話冷場了。判斷此刻你是否自然想主動說一句話。"
                    "重要：越被晾著越要懂得給空間——硬找話會顯得需求感很重，沉默常常才是對的。"
                ),
                messages=[{"role": "user", "content": (
                    f"最近對話：\n{recent}\n\n"
                    f"現在冷場：你已經主動開口 {n} 次、對方都還沒回應，已經安靜約 {quiet_for} 秒。"
                    "用你的人格判斷：此刻自然、不突兀地想再說一句嗎？"
                    "想說就『只輸出那一句話本身』（可以接話題／輕輕關心／或只是一句『我在喔』，"
                    "戳越多次語氣要越淡、越退）；"
                    "若這時候安靜才自然、或硬找話會尷尬，就輸出空字串，什麼都不要寫。"
                )}],
            )
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
            text = text.strip("（）()「」\"' ")
            if text and text not in ("沉默", "NOTHING", "無", "空", "（沉默）"):
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

    logger.info(f"3a active(擬真backoff): baseline={baseline_secs:.1f}s ×{BACKOFF} cap={MAX_INTERVAL:.0f}s im={im_threshold}")
