"""
ailiveX realtime agent — LiveKit Agent 入口（Phase 6）

STT: Soniox stt-rt-v4（中英文雙語）
LLM: bridge（Max OAuth）→ fallback Anthropic direct
TTS: MiniMax speech-02-turbo（自訂 wrapper）
VAD: Silero

差異於 ailive：
- agent_name = ailivex-realtime（隔離 dispatch）
- PROJECT_NAMESPACE = ailivex（room name 前綴 ailivex-）
- Collections: characters / conversations / memories（不是 platform_*）
- convId 格式: ailivex-voice-{characterId}-{userId}（對齊 token route）
- 記憶嚴格綁 userId×characterId（不共享）
- 工具只有 write_document（去掉索/奧/聲紋/承諾）
- 通話結束寫回 conversations + memories（in-process，不走 Cloud Tasks）
"""
import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone

from livekit.agents import Agent, AgentSession, JobContext, function_tool
from livekit.plugins import silero, anthropic, soniox
from firebase_admin import firestore

from src.minimax_tts import MiniMaxCustomTTS
from src.firestore_loader import (
    load_character,
    load_conversation,
    load_memory_block,
    save_conversation,
    save_voice_memory,
    build_system_prompt,
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger("ailivex-realtime")

PROJECT_NAMESPACE = "ailivex"

FALLBACK_PROMPT = (
    "你是一個禮貌、簡短的 AI 夥伴。這是即時語音通話。"
    "用繁體中文回覆，一兩句話即可。不要說（思考）（停頓）這類 stage directions。"
)


async def entrypoint(ctx: JobContext):
    logger.info(f"Job dispatched: room={ctx.room.name}")

    if not ctx.room.name.startswith(f"{PROJECT_NAMESPACE}-"):
        logger.critical(
            f"SECURITY: Room '{ctx.room.name}' lacks '{PROJECT_NAMESPACE}-' prefix. Rejecting."
        )
        return

    # 解析 dispatch metadata
    dispatch_metadata = {}
    try:
        if ctx.job.metadata:
            dispatch_metadata = json.loads(ctx.job.metadata)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning(f"metadata parse failed: {e}")

    character_id = dispatch_metadata.get("characterId", "")
    user_id = dispatch_metadata.get("userId", "")
    conv_id = dispatch_metadata.get("convId", "") or f"ailivex-voice-{character_id}-{user_id}"
    char_name = dispatch_metadata.get("characterName", "") or "agent"

    # 從 Firestore 讀角色 soul + 對話記憶
    system_prompt = FALLBACK_PROMPT
    char_ctx = None
    if character_id:
        try:
            char_ctx = load_character(character_id)
            conv_ctx = load_conversation(conv_id)
            mem_block = load_memory_block(user_id, character_id) if user_id else ""
            system_prompt = build_system_prompt(char_ctx, conv_ctx, mem_block)
            char_name = char_ctx.name
            logger.info(
                f"Loaded: char={char_name} soul={len(char_ctx.soul_text)}c "
                f"summary={len(conv_ctx.summary)}c msgs={len(conv_ctx.messages)} "
                f"memories={'yes' if mem_block else 'none'}"
            )
        except Exception as e:
            logger.error(f"Firestore load failed, using fallback: {e}")
    else:
        logger.warning("No characterId in metadata, using fallback prompt")

    await ctx.connect()
    participant = await ctx.wait_for_participant()
    logger.info(f"Participant joined: {participant.identity}")

    # VAD
    vad = silero.VAD.load(
        min_silence_duration=0.4,
        prefix_padding_duration=0.3,
        min_speech_duration=0.1,
        activation_threshold=0.5,
    )

    # STT — Soniox
    soniox_key = os.environ.get("SONIOX_API_KEY", "")
    if not soniox_key:
        logger.critical("SONIOX_API_KEY missing")
        return
    stt = soniox.STT(
        api_key=soniox_key,
        params=soniox.STTOptions(model="stt-rt-v4", language_hints=["zh", "en"]),
    )

    # LLM — bridge（Max OAuth）或 direct API key
    bridge_url = os.environ.get("BRIDGE_URL", "")
    bridge_secret = os.environ.get("BRIDGE_SECRET", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if bridge_url and bridge_secret:
        logger.info(f"LLM: bridge at {bridge_url}")
        llm = anthropic.LLM(
            model="claude-sonnet-4-6",
            api_key=bridge_secret,
            base_url=bridge_url,
            temperature=0.7,
            caching="ephemeral",
        )
    elif anthropic_key:
        logger.info("LLM: direct Anthropic API key")
        llm = anthropic.LLM(
            model="claude-haiku-4-5-20251001",
            api_key=anthropic_key,
            temperature=0.7,
        )
    else:
        logger.critical("No LLM credentials: set BRIDGE_URL+BRIDGE_SECRET or ANTHROPIC_API_KEY")
        return

    # TTS — MiniMax
    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    minimax_group_id = os.environ.get("MINIMAX_GROUP_ID", "")
    default_voice_id = os.environ.get("MINIMAX_DEFAULT_VOICE_ID", "")
    if not minimax_key or not minimax_group_id or not default_voice_id:
        logger.critical("MINIMAX_API_KEY / MINIMAX_GROUP_ID / MINIMAX_DEFAULT_VOICE_ID missing")
        return

    voice_id = (char_ctx.voice_id_minimax if char_ctx else "") or default_voice_id
    tts = MiniMaxCustomTTS(
        api_key=minimax_key,
        group_id=minimax_group_id,
        voice_id=voice_id,
        model="speech-02-turbo",
    )
    logger.info(f"TTS: MiniMax voice={voice_id}")

    # Firestore client（給 write_document tool 用）
    db = firestore.client()

    @function_tool(
        name="write_document",
        description=(
            "用戶要求角色幫他/她產生一份文件時使用這個工具（策略書、企劃書、報告等）。"
            "呼叫後系統會在背景幫用戶生成 HTML 文件，完成後在「我的文件」頁面可看到。"
            "決定幫用戶寫文件後直接呼叫，工具回來再跟用戶確認。"
        ),
    )
    async def write_document(title: str, brief: str) -> str:  # type: ignore[misc]
        """
        title: 文件標題（簡短）
        brief: 給文件生成系統的工作說明（用戶要什麼、格式、重點）
        """
        if not brief:
            return "需要 brief 才能生成文件。"
        if not user_id or not character_id:
            return "缺少 userId / characterId，無法建立文件任務。"
        try:
            def _create():
                doc_ref = db.collection("documents").document()
                doc_ref.set({
                    "userId": user_id,
                    "characterId": character_id,
                    "title": title or "未命名文件",
                    "mdContent": "",
                    "htmlUrl": "",
                    "status": "pending",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                })
                job_ref = db.collection("jobs").document()
                job_ref.set({
                    "userId": user_id,
                    "characterId": character_id,
                    "type": "document",
                    "documentId": doc_ref.id,
                    "brief": brief,
                    "status": "pending",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                })
                return doc_ref.id
            doc_id = await asyncio.to_thread(_create)
            logger.info(f"[write_document] created doc={doc_id} for user={user_id}")
            short_id = doc_id[:8]
            return (
                f"DOC_PENDING:{doc_id}:"
                f"文件任務已建立（{short_id}）。"
                f"系統正在背景生成，幾分鐘後在「我的文件」頁面可以看到。"
            )
        except Exception as e:
            logger.error(f"[write_document] failed: {e}")
            return f"文件任務建立失敗：{e}"

    # transcript 收集（通話結束後寫回 Firestore）
    transcript: list = []

    agent = Agent(instructions=system_prompt, tools=[write_document])
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad)
    call_start = time.time()

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        text = getattr(item, "text_content", "") or getattr(item, "content", "") or ""
        if text.strip() and role in ("user", "assistant"):
            transcript.append({
                "role": role,
                "content": text.strip(),
                "at": datetime.now(timezone.utc).isoformat(),
            })

    @ctx.room.on("disconnected")
    def on_disconnected():
        import threading
        threading.Thread(target=_cleanup, daemon=False).start()

    def _cleanup():
        try:
            duration = time.time() - call_start
            logger.info(f"[cleanup] disconnected after {duration:.1f}s, transcript={len(transcript)} msgs")
            if not transcript or not conv_id:
                return

            # 寫回 conversations
            save_conversation(
                conv_id=conv_id,
                user_id=user_id,
                character_id=character_id,
                new_messages=transcript,
            )

            # 從 transcript 提煉記憶（用 bridge 呼叫）
            if user_id and character_id and len(transcript) >= 2:
                _extract_and_save_memory(transcript, user_id, character_id)
        except Exception as e:
            logger.error(f"[cleanup] failed: {e}", exc_info=True)

    def _extract_and_save_memory(transcript_msgs: list, uid: str, cid: str) -> None:
        """呼叫 bridge/Anthropic → 提煉 1-2 條記憶 → 寫 memories collection"""
        try:
            import anthropic as anthropic_sdk
            dialogue = "\n".join(
                f"{'用戶' if m['role'] == 'user' else '角色'}：{m['content'][:150]}"
                for m in transcript_msgs[-16:]
            )
            if len(dialogue) < 30:
                return
            # 優先走 bridge
            burl = os.environ.get("BRIDGE_URL", "")
            bsec = os.environ.get("BRIDGE_SECRET", "")
            akey = os.environ.get("ANTHROPIC_API_KEY", "")
            if burl and bsec:
                client = anthropic_sdk.Anthropic(api_key=bsec, base_url=burl)
                model = "claude-haiku-4-5-20251001"
            elif akey:
                client = anthropic_sdk.Anthropic(api_key=akey)
                model = "claude-haiku-4-5-20251001"
            else:
                return
            resp = client.messages.create(
                model=model,
                max_tokens=300,
                messages=[{
                    "role": "user",
                    "content": (
                        "以下是一段即時語音對話。請提煉出 1-2 條角色應該記住的重要訊息。\n"
                        "只寫用戶明確說出的具體事（名字/處境/喜好/承諾等），不要推測。\n"
                        "每條一句話，直接輸出，每行一條，不要編號。\n\n"
                        f"對話：\n{dialogue}"
                    ),
                }],
            )
            raw = resp.content[0].text.strip()
            for line in raw.split("\n"):
                line = line.strip()
                if len(line) > 5:
                    save_voice_memory(uid, cid, line)
        except Exception as e:
            logger.warning(f"[extract_memory] failed: {e}")

    await session.start(agent=agent, room=ctx.room)
    logger.info("Session started")

    try:
        await session.generate_reply(
            instructions="用一句話自然打招呼，符合你的人格。如果記憶中有上次聊過的東西，可以順手帶出。",
        )
    except Exception as e:
        logger.error(f"initial greeting failed: {e}")
