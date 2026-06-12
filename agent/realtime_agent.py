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
from agent.conv_tuning import build_turn_handling
from agent.firestore_loader import (
    load_character,
    load_conversation,
    load_memories,
    load_relationship,
    save_conversation,
    write_memory,
    build_system_prompt,
    extract_and_save_memories,
    create_document_job,
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("ailivex-realtime")

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
        model="claude-haiku-4-5-20251001",
        api_key=anthropic_key,
        temperature=0.7,
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
        model="speech-02-turbo",
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

    agent = Agent(instructions=system_prompt, tools=[remember_tool, write_document_tool])
    logger.info(f"Agent initialized, soul={len(system_prompt)} chars")

    _conv = char_ctx.conv_settings if char_ctx else {}
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad,
                           turn_handling=build_turn_handling(_conv))

    call_start = time.time()
    transcript: list = []

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        text = getattr(item, "text_content", "") or getattr(item, "content", "") or ""
        if text and text.strip() and role in ("user", "assistant"):
            transcript.append({"role": role, "content": text.strip()})

    @ctx.room.on("disconnected")
    def on_disconnected():
        duration = time.time() - call_start
        logger.info(f"Room disconnected after {duration:.1f}s, messages={len(transcript)}")
        if transcript and conv_id and user_id and character_id:
            try:
                save_conversation(conv_id, user_id, character_id, transcript)
                logger.info(f"Saved {len(transcript)} messages to {conv_id}")
            except Exception as e:
                logger.error(f"save_conversation failed: {e}")

            # 被動記憶提煉（session 結束後同步跑，用戶已離線不影響體驗）
            try:
                char_name = char_ctx.name if char_ctx else character_id
                extract_and_save_memories(
                    user_id, character_id, char_name, transcript,
                    bridge_url=os.environ.get("BRIDGE_URL", ""),
                    bridge_secret=os.environ.get("BRIDGE_SECRET", ""),
                    api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
                )
            except Exception as e:
                logger.error(f"extract_and_save_memories failed: {e}")

    await session.start(agent=agent, room=ctx.room)
    logger.info("Session started, agent active")

    try:
        await session.generate_reply(
            instructions="用一句話自然打招呼，符合你的人格。如果有之前的對話摘要，可以自然帶出。",
        )
        logger.info("Initial greeting sent")
    except Exception as e:
        logger.error(f"Initial greeting failed: {e}")
