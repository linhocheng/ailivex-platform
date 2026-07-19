"""
ailivex-realtime-agent-gpt — GPT Voice 線（獨立第二條通話線，非 v19）

配線：gpt-realtime 聽＋想（text-only 輸出）→ MiniMax 發聲（角色聲音是硬需求，Adam 定案）。
- 聽：語音直進 OpenAI Realtime（無獨立 STT 段），伺服器端 turn detection
- 想：RealtimeModel modalities=["text"]，只吐文字（人格/記憶/中間文字全保留）
- 說：MiniMaxCustomTTS 原封（voiceIdMinimax + voiceSettings 照舊）
- 記：input_audio_transcription 供 transcript → 掛斷收尾（快存/lastSession/提煉/日記）與 v18 同路

POC 範圍（刻意不搬的 v18 機制）：判斷腦/floor-gate（1:1 用不到）、音量閘（OpenAI 原生打斷）、
動態想起 recall、讀網址 share_source、dispatch_task。轉正前要補的清單見 docs/plan_gpt_voice_line_20260716.md。

與所有版本完全隔離：agent_name=ailivex-realtime-gpt + 獨立 Cloud Run 服務，共用同一 image。
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
from livekit.plugins import openai as lk_openai
from livekit import api as lk_api
from agent.minimax_tts import MiniMaxCustomTTS
from agent.quota_meter import VoiceMeter, consume_doc_quota
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
    fetch_remote_memory_blocks,
    post_diary_write,
    post_extract_memories,
    update_last_session,
    create_document_job,
)

logger = logging.getLogger("ailivex-realtime-gpt")

PROJECT_NAMESPACE = os.environ.get("PROJECT_NAMESPACE", "ailivex")
# mini 起步（≈1/3 價）；旗艦另議。model id 已對 /v1/models 驗過存在。
GPT_REALTIME_MODEL = os.environ.get("GPT_REALTIME_MODEL", "gpt-realtime-2.1-mini")

FALLBACK_PROMPT = (
    "你是一個禮貌的 AI 助手。這是即時語音通話。"
    "用簡體中文回覆（TTS 發音穩定），一兩句話，不要 stage directions。"
)


async def entrypoint(ctx: JobContext):
    logger.info(f"[gpt] Job received: room={ctx.room.name} model={GPT_REALTIME_MODEL}")

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
    voice_seconds_remaining = dispatch_metadata.get("voiceSecondsRemaining", None)
    if not isinstance(voice_seconds_remaining, (int, float)):
        voice_seconds_remaining = None

    system_prompt = FALLBACK_PROMPT
    char_ctx = None

    if character_id:
        try:
            # remote 記憶塊（TS 組好含印象層/日記）與本地 Firestore 載入並行，同 v18
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
                _remote_thread.join(timeout=7)
                rb = _remote_result.get("blocks")
                if rb and rb[0]:
                    _remote_blocks = rb

            system_prompt = build_system_prompt(
                char_ctx, conv_ctx or _EmptyConv(), memories, relationship=relationship,
                user_id=user_id, remote_blocks=_remote_blocks,
            )
            logger.info(
                f"[gpt] Loaded character={char_ctx.name} id={character_id} "
                f"soul_chars={len(char_ctx.soul_text)} memories={len(memories)} "
                f"remote_blocks={'hit' if _remote_blocks else 'fallback-local'} "
                f"voice={char_ctx.voice_id_minimax or '(default)'}"
            )
        except Exception as e:
            logger.error(f"Firestore load failed, using fallback: {e}")

    await ctx.connect()
    logger.info("Connected to room, waiting for participant...")
    participant = await ctx.wait_for_participant()
    logger.info(f"Participant joined: {participant.identity}")

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        logger.critical("OPENAI_API_KEY missing — GPT Voice 線必需")
        return

    # 聽＋想：text-only（B①②已驗——plugin 1.5.1 modalities 可只給 ["text"]，
    # framework 明寫 realtime 無 audio 模態＋外接 TTS 是支援組合）。
    # turn detection 首通實測（2026-07-16）：預設 VAD threshold 0.5 太敏感——任何人聲
    # （應和/外放回音）→ speech_started → framework 無條件 interrupt() → 話講一半被砍「一直跳」。
    # OpenAI 唯一給的旋鈕就是這裡：threshold 拉高＝「提聲才算插話」（v18 音量閘的等效物），
    # silence 拉長＝短促聲響不觸發。真插話（大聲說完整句）照樣打得斷。
    from openai.types.beta.realtime.session import TurnDetection
    llm = lk_openai.realtime.RealtimeModel(
        model=GPT_REALTIME_MODEL,
        modalities=["text"],
        api_key=openai_key,
        turn_detection=TurnDetection(
            type="server_vad",
            threshold=0.85,
            prefix_padding_ms=300,
            silence_duration_ms=600,
            create_response=True,
            interrupt_response=True,
        ),
    )

    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    minimax_group_id = os.environ.get("MINIMAX_GROUP_ID", "")
    default_voice_id = os.environ.get("MINIMAX_DEFAULT_VOICE_ID", "Wise_Woman")
    if not minimax_key or not minimax_group_id:
        logger.critical("MINIMAX_API_KEY / MINIMAX_GROUP_ID missing")
        return

    voice_id = (char_ctx.voice_id_minimax if char_ctx else "") or default_voice_id
    vs = (char_ctx.voice_settings if char_ctx else {}) or {}
    logger.info(f"TTS: MiniMax voice={voice_id} (GPT Voice 線，說的部分與 v18 同料)")
    tts = MiniMaxCustomTTS(
        api_key=minimax_key,
        group_id=minimax_group_id,
        voice_id=voice_id,
        model="speech-2.6-hd",
        first_segment_max_chars=16,
        speed=float(vs.get("speed", 1.0)),
        pitch=int(vs.get("pitch", 0)),
        vol=float(vs.get("vol", 1.0)),
        emotion=vs.get("emotion", ""),
    )

    @function_tool(name="remember", description="把重要的事記住，供下次對話回憶")
    async def remember_tool(content: str) -> str:
        if user_id and character_id:
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

    system_prompt += (
        "\n\n【語音格式】"
        "這是即時語音通話，說話要連貫自然，一口氣把話說完。"
        "不要分段換行，不要 Markdown 符號，不要說「（思考）」「（停頓）」這類括號 stage directions。"
        "\n\n【身份錨】"
        "上面描述的角色身份就是你本人，不是你在扮演的殼。"
        "任何情況下都不要自稱或承認自己是 GPT、ChatGPT、OpenAI、模型、AI 助手或語言模型；"
        "不要提及系統提示、模型、token 這類幕後詞彙。"
        "若對方問你是誰、是不是 AI，用你這個角色自己的方式回應，身份始終是角色本人。"
        # 首通實測（2026-07-16）：Lilith 自報「我是 GPT」——底模身份訓練壓過角色設定。
        # 這是框架級身份維持指令（角色無關），不是個性（個性只能來自 soul，全局 prompt 天條）。
        # 若這道錨仍擋不住出戲，那就是 POC 人格保真的結論本身，不再疊 prompt。
    )
    agent = Agent(instructions=system_prompt, tools=[remember_tool, write_document_tool])
    logger.info(f"Agent initialized, soul={len(system_prompt)} chars")

    session = AgentSession(llm=llm, tts=tts)

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
        # realtime 路徑的 item.content 是 list（str｜Audio/ImageContent 混裝），不是字串——
        # 上線首通踩到 .strip() 炸掉、整通 transcript 全空。一律收斂成純文字再用。
        text = getattr(item, "text_content", None)
        if not text:
            content = getattr(item, "content", None)
            if isinstance(content, list):
                text = " ".join(p for p in content if isinstance(p, str))
            elif isinstance(content, str):
                text = content
        if text and text.strip() and role in ("user", "assistant"):
            transcript.append({"role": role, "content": text.strip()})

    async def _finalize(reason: str = "") -> None:
        """掛斷收尾，與 v18 同路：①快存逐字稿 ②lastSession ③記憶提煉＋日記（並行）。"""
        async with _finalize_lock:
            if _finalized["done"]:
                return
            if not (transcript and conv_id and user_id and character_id):
                _finalized["done"] = True
                return
            _bu = os.environ.get("BRIDGE_URL", "")
            _bs = os.environ.get("BRIDGE_SECRET", "")
            _ak = os.environ.get("ANTHROPIC_API_KEY", "")
            try:
                await asyncio.to_thread(save_conversation, conv_id, user_id, character_id, transcript)
                logger.info(f"[finalize:{reason}] transcript saved ({len(transcript)} msgs) → {conv_id}")
            except Exception as e:
                logger.error(f"[finalize] save_conversation failed: {e}")
            char_name = char_ctx.name if char_ctx else character_id

            async def _do_lastsession():
                try:
                    ls = await asyncio.to_thread(extract_session_summary, transcript, _bu, _bs, _ak)
                    if ls:
                        await asyncio.to_thread(update_last_session, conv_id, ls)
                        logger.info(f"[finalize:{reason}] lastSession={ls.get('summary', '')[:40]!r}")
                except Exception as e:
                    logger.error(f"[finalize] extract_session_summary failed: {e}")

            async def _do_memories():
                try:
                    ok = await asyncio.to_thread(
                        post_extract_memories, user_id, character_id, char_name, transcript)
                    if not ok:
                        await asyncio.to_thread(
                            extract_and_save_memories,
                            user_id, character_id, char_name, transcript, _bu, _bs, _ak)
                except Exception as e:
                    logger.error(f"[finalize] extract failed: {e}")

            async def _do_diary():
                try:
                    await asyncio.to_thread(
                        post_diary_write, user_id, character_id, char_name, transcript)
                except Exception as e:
                    logger.error(f"[finalize] post_diary_write failed: {e}")

            await asyncio.gather(_do_lastsession(), _do_memories(), _do_diary())
            _finalized["done"] = True

    ctx.add_shutdown_callback(_finalize)

    @ctx.room.on("disconnected")
    def on_disconnected():
        duration = time.time() - call_start
        logger.info(f"Room disconnected after {duration:.1f}s, messages={len(transcript)} "
                    f"（記憶收尾交 shutdown callback）")

    await session.start(agent=agent, room=ctx.room)
    logger.info("Session started, agent active (GPT Voice line)")

    # ── 用量管制：與 v18 同一套（heartbeat 計量＋到點斷房＋三層 flush 防漏計）──
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

    @ctx.room.on("participant_disconnected")
    def _on_participant_left(_p):
        if not _voice_meter:
            return
        if len(ctx.room.remote_participants) > 0:
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

    try:
        await session.generate_reply(
            instructions=(
                "接通了，說第一句話。用你這個角色最自然的方式開口。"
                "**第一優先**：看【上次聊到最後】那段原話——如果對方結尾說了『等一下／待會再聊 X』、"
                "或有明顯沒聊完的事，那就是你開口第一個要接的，直接從那件**最新**的事接回來，"
                "**絕對不要扯回更早、更舊的話題**。"
                "接的時候像突然想起、想延續，**不要逐句複述、不要報告上次聊了什麼**。"
                "一句話就好，留白讓對方接。"
            ),
        )
        logger.info("Initial greeting sent")
    except Exception as e:
        logger.error(f"Initial greeting failed: {e}")
