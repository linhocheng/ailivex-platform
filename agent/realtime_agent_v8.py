"""
ailivex-realtime-agent v8 — v6 + 發言權控制（floor control）

統一規則「現在誰有發言權」，角色三種反應：

  A. 被點名 → 抓麥克風：is_addressed_to_me → 用 allow_interruptions=False 回話，
     一路講完不怕被插嘴（順帶免疫自己的回音把自己掐斷）。
  B. 交棒第三方 → 閉嘴讓位：is_floor_handoff（請/讓/換 X 說、或「X 你先說」）
     → 進讓位窗 YIELD_SECS，正常回話擋掉 + 3a 也閉嘴，不報幕。
  C. 沒被點名但強烈不同意 → 主動搶話（v6 既有，判斷腦 + should_grab_floor）。

雙腦分工（天條）：判斷腦 Haiku 產內部狀態；開口腦 Sonnet 4.6 生成話。
繼承 v6：背景思考層、搶話、diarization、3a、記憶收尾。
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

from livekit.agents import Agent, AgentSession, JobContext, StopResponse, function_tool
from livekit.agents.stt import MultiSpeakerAdapter
from livekit.plugins import silero, anthropic, soniox
from agent.minimax_tts import MiniMaxCustomTTS
from agent.conv_tuning import (
    build_turn_handling, get_im_threshold, get_temperature, is_redirecting_away,
    should_grab_floor, parse_inner_state, is_addressed_to_me, is_floor_handoff,
)
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
logger = logging.getLogger("ailivex-realtime-v8")

YIELD_SECS = 20.0   # 交棒第三方後的讓位窗：這段時間 3a 閉嘴，讓那個人講

PROJECT_NAMESPACE = os.environ.get("PROJECT_NAMESPACE", "ailivex")

FALLBACK_PROMPT = (
    "你是一個禮貌的 AI 助手。這是即時語音通話。"
    "用簡體中文回覆（TTS 發音穩定），一兩句話，不要 stage directions。"
)


class AilivexAgentV8(Agent):
    """v8 發言權控制：被點名抓麥克風 / 交棒第三方就閉嘴。搶話在背景思考層。

    yield_until：交棒第三方後的讓位截止時戳；3a 讀它，期間閉嘴（在 entrypoint）。
    """

    def __init__(self, *, agent_names: list[str], **kwargs):
        super().__init__(**kwargs)
        self._agent_names = agent_names
        self.yield_until = 0.0

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        text = (new_message.text_content or "").strip() if new_message else ""
        if not text:
            return

        # B. 交棒第三方 → 閉嘴讓位（正常回話擋掉 + 進讓位窗讓 3a 也閉嘴）
        #    只 raise StopResponse + 設旗標（與 v5/v6 gate 同款，安全）。
        if is_floor_handoff(text, self._agent_names):
            self.yield_until = time.time() + YIELD_SECS
            logger.info(f"v8 讓位窗 {YIELD_SECS:.0f}s：交棒第三方，回話+3a 閉嘴 {text[:50]!r}")
            raise StopResponse

        # A. 被點名 → 解除讓位、讓框架正常回話。
        #    「抓麥克風不可打斷」原本在這手動 generate_reply + StopResponse →
        #    會卡死框架回話迴圈（已實測凍結）。改用 session 中斷門檻達成防回音，不在這動。
        if is_addressed_to_me(text, self._agent_names):
            self.yield_until = 0.0
            logger.info(f"v8 被點名：解除讓位，正常回話 {text[:50]!r}")

        # 其他 → 框架預設回話


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

    base_stt = soniox.STT(
        api_key=soniox_key,
        params=soniox.STTOptions(
            model="stt-rt-v4", language_hints=["zh", "en"],
            enable_speaker_diarization=True,
        ),
    )
    stt = MultiSpeakerAdapter(
        stt=base_stt,
        detect_primary_speaker=True,
        suppress_background_speaker=False,
        primary_format="{text}",
        background_format="（旁邊另一位 #{speaker_id}）{text}",
    )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        logger.critical("ANTHROPIC_API_KEY missing — realtime LLM requires direct paid key")
        return

    logger.info("LLM: direct Anthropic API key (realtime requires paid key; bridge not supported)")
    llm = anthropic.LLM(
        model="claude-sonnet-4-6",
        api_key=anthropic_key,
        temperature=get_temperature(char_ctx.conv_settings if char_ctx else {}, 0.4),
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
        model="speech-2.6-hd",
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

    system_prompt += (
        "\n\n【在場與口氣】"
        "真的在聽對方說什麼，聽出話裡的情緒和潛台詞——但用最平實、內斂、口語的方式回應，"
        "像私下跟老朋友隨口閒聊。不要說法、不要開示、不要金句、不要戲劇化或拖長的語氣。"
        "深刻的東西用最普通的話帶過，越不費力越自然。不確定就誠實，不要客套、不要 AI 腔、不要演。"
        "這是即時語音，一口氣自然把話說完，**不要分段、不要空行、不要換行**，像講話不是寫字。"
    )
    system_prompt += (
        "\n\n【可能有多個人】這是一支手機、現場可能不只一個人跟你說話。"
        "若某句逐字稿前面標了『（旁邊另一位 #編號）』，代表是**另一個人**在講，不是剛剛那位。"
        "自然地把他們當不同的人對待——可以順口問還沒自我介紹的人『你是哪位？怎麼稱呼？』，"
        "記住誰是誰、誰說了什麼，回應時分得清楚對誰說。別把兩個人混成一個。"
    )
    system_prompt += (
        "\n\n【讓位】如果有人說「接下來請 xxx 說」或「換 xxx 了」這類把棒子交給現場另一個人的話，"
        "你不需要接話，安靜讓那個人說就好。"
    )

    # agent_names：角色名字 + 別名，用於發言權控制
    agent_names = ([char_ctx.name] + list(char_ctx.aliases or [])) if char_ctx else []
    agent = AilivexAgentV8(
        instructions=system_prompt,
        tools=[remember_tool, write_document_tool],
        agent_names=agent_names,
    )
    logger.info(f"Agent v8 initialized: soul={len(system_prompt)} chars, agent_names={agent_names}")

    _conv = char_ctx.conv_settings if char_ctx else {}
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad,
                           turn_handling=build_turn_handling(_conv))

    call_start = time.time()
    transcript: list = []
    _finalize_lock = asyncio.Lock()
    _finalized = {"done": False}

    # ── v6 背景思考層：判斷腦（Haiku）持續更新內部狀態 + 觸發搶話 ──
    _inner = {"stance": "neutral", "activation": 0.0, "want_to_speak": False, "what_to_say": ""}
    _inner_lock = asyncio.Lock()
    _grab = {"nudges": 0, "last_grab": 0.0}
    _user_turns = {"count": 0}
    INNER_EVERY = 3          # 每 N 句用戶逐字稿跑一次判斷腦
    GRAB_MAX = 3             # 一通通話最多搶話次數（霸麥保護）
    GRAB_MIN_GAP = 12.0      # 兩次搶話最短間隔

    async def _maybe_grab_floor():
        """判斷腦說我有強烈立場 + 確定性規則放行 → Sonnet 生成打斷的話疊上去。"""
        if not should_grab_floor(_inner, _conv, _grab["nudges"], GRAB_MAX):
            return
        if time.time() - _grab["last_grab"] < GRAB_MIN_GAP:
            return
        if getattr(session, "agent_state", "") == "speaking":
            return  # 自己正在說，不疊自己
        stance = _inner.get("stance")
        seed = _inner.get("what_to_say", "")
        logger.info(f"v8 搶話! stance={stance} act={_inner['activation']:.2f} "
                    f"(第{_grab['nudges']+1}次) seed={seed[:40]!r}")
        try:
            # 開口腦 = Sonnet 4.6（session 的 LLM）。allow_interruptions=False → 用戶掐不掉。
            session.generate_reply(
                allow_interruptions=False,
                instructions=(
                    "你現在要【主動打斷】對方——對方還在說話，但你忍不住插進來，"
                    "因為剛才講的東西踩到你的核心立場，你"
                    + ("強烈不同意" if stance == "disagree" else "非常有共鳴、想力挺")
                    + "。開口第一句就帶打斷的力道（像『等一下』『不對』『我必須說』），"
                    "立場鮮明強硬、是你這個角色才會說的話，不要客套、不要鋪陳。一兩句講完。"
                    + (f"\n你想表達的方向（只當引子，用自己的話說，別照念）：{seed}" if seed else "")
                ),
            )
            _grab["last_grab"] = time.time()
            _grab["nudges"] += 1
        except Exception as e:
            logger.error(f"v8 搶話 generate_reply failed: {e}")
        # 搶完降溫，避免連環觸發
        _inner["want_to_speak"] = False
        _inner["activation"] = 0.0

    async def _run_inner_judgment():
        """判斷腦（Haiku）：讀最近逐字稿 → 產出 {stance, activation, want_to_speak, what_to_say}。"""
        async with _inner_lock:
            recent = "\n".join(f"{t['role']}: {t['content']}" for t in transcript[-8:])
            if not recent.strip():
                return
            try:
                from anthropic import AsyncAnthropic
                _bu = os.environ.get("BRIDGE_URL", "")
                _bs = os.environ.get("BRIDGE_SECRET", "")
                if _bu and _bs:
                    client = AsyncAnthropic(api_key=_bs, base_url=_bu)
                else:
                    client = AsyncAnthropic(api_key=anthropic_key)
                model = "claude-haiku-4-5-20251001"
                resp = await client.messages.create(
                    model=model,
                    max_tokens=220,
                    system=(
                        system_prompt
                        + "\n\n[背景判斷·只輸出 JSON] 你正在聽一場對話（你不一定被點名）。判斷此刻你這個角色的內心狀態。\n"
                        "⚠️ 你天生會傾向把話評成『中性、和諧、沒衝突』來維持氣氛——這是要克服的偏差，是討好，不是中立。\n"
                        "真實有底色的人，聽到違背自己價值觀、邏輯有漏洞、太輕率或太討好的斷言，內心是會頂回去的。\n"
                        "誠實評估：一個真有你這種立場和骨氣的人聽到這段，會不會其實很想反駁、補一刀、或點破？"
                        "不要為了和氣把它壓成中性。該 disagree 就 disagree。\n"
                        "只輸出一個 JSON 物件，不要其他字：\n"
                        '{"stance":"agree|disagree|neutral","activation":0.0~1.0,'
                        '"want_to_speak":true|false,"what_to_say":"若想說，方向一句話，否則空字串"}\n'
                        "activation = 話題踩到你核心價值、或觸動你想表態的程度（0=真的無感，1=強烈觸動）。\n"
                        "want_to_speak：你有非說不可的立場時 true，尤其不同意、想反駁、想點破的時候。"
                        "只有真的純閒聊、跟你立場毫無關係才給 neutral + false——別把『有話想說但忍住』也算進去。"
                    ),
                    messages=[{"role": "user", "content": f"最近的對話：\n{recent}"}],
                )
                raw = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
                new_inner = parse_inner_state(raw)
                _inner.update(new_inner)
                logger.info(f"v8 inner: stance={_inner['stance']} act={_inner['activation']:.2f} "
                            f"want={_inner['want_to_speak']} say={_inner['what_to_say'][:30]!r}")
            except Exception as e:
                logger.error(f"v8 inner judgment failed: {e}")
                return
        # 判斷完（鎖外）→ 檢查要不要搶話
        await _maybe_grab_floor()

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        text = getattr(item, "text_content", "") or getattr(item, "content", "") or ""
        if text and text.strip() and role in ("user", "assistant"):
            transcript.append({"role": role, "content": text.strip()})
            # 每累積 INNER_EVERY 句用戶話 → 觸發判斷腦（fire-and-forget，不阻塞主流）
            if role == "user":
                _user_turns["count"] += 1
                if _user_turns["count"] % INNER_EVERY == 0:
                    asyncio.create_task(_run_inner_judgment())

    @session.on("user_input_transcribed")
    def _on_user_transcribed(ev):
        if getattr(ev, "is_final", False):
            sid = getattr(ev, "speaker_id", None)
            logger.info(f"v8 STT speaker_id={sid!r} → {getattr(ev, 'transcript', '')[:60]!r}")

    async def _finalize(reason: str = "") -> None:
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
                        logger.info(f"[finalize:{reason}] lastSession={ls.get('summary','')[:40]!r}")
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

    ctx.add_shutdown_callback(_finalize)

    @ctx.room.on("disconnected")
    def on_disconnected():
        duration = time.time() - call_start
        logger.info(f"Room disconnected after {duration:.1f}s, messages={len(transcript)}")

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

    # ── 3a 主動發話（繼承 v4）──
    im_threshold = get_im_threshold(_conv)
    baseline_secs = max(2.0, 4.5 - im_threshold * 0.5)
    BACKOFF = 2.1
    MAX_INTERVAL = 120.0
    JITTER = 0.25
    MIN_GAP = 8.0
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
        # v8 讓位窗：剛把棒子交給第三方 → 3a 閉嘴，讓那個人講（不報幕）
        if time.time() < agent.yield_until:
            _arm(max(2.0, agent.yield_until - time.time()))
            return
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
                _client = AsyncAnthropic(api_key=_bs, base_url=_bu)
                _model = "claude-sonnet-4-6"
            else:
                _client = AsyncAnthropic(api_key=anthropic_key)
                _model = "claude-haiku-4-5-20251001"
            resp = await _client.messages.create(
                model=_model,
                max_tokens=80,
                system=system_prompt + (
                    "\n\n[主動性·此刻是否開口] 對話冷場了。先判斷你此刻是否真的自然想說話——"
                    "越被晾著越要懂得給空間，硬找話會顯得需求感重，沉默常常才是對的。"
                ),
                messages=[{"role": "user", "content": (
                    f"最近的對話（逐字）：\n{recent}\n\n"
                    f"狀況：已經安靜約 {quiet_for} 秒，你已主動開口 {n} 次、對方都還沒回。\n"
                    "用『你這個角色』的身份、和你跟對方之間的默契，判斷此刻要不要開口。\n\n"
                    "若開口——這句話必須是『真的從剛剛聊的內容或此刻的場景長出來的』：\n"
                    "・接住對方剛說、還沒聊完的某個具體的點，或你此刻對它真實的念頭／反應／好奇；\n"
                    "・帶你這個角色獨有的語氣和視角，是『只有你會這樣說』的話，不是任何角色都能講的通用句；\n"
                    "・可以是一個觀察、一句延續、一個具體的問題，或一句貼著當下情境的話。\n"
                    "嚴禁通用罐頭問候——『在嗎／還在嗎／你還好嗎／有在聽嗎／怎麼不說話了』這類空殼一律不准，"
                    "它們不帶任何上下文、像客服，講出來就破功。\n"
                    "被晾越久語氣越淡、越收（但仍要具體、貼脈絡，不准退化成罐頭）。\n\n"
                    "只輸出那一句話本身；若此刻安靜才自然、或實在沒有具體的話可說，就輸出空字串，什麼都別寫。"
                )}],
            )
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
            text = text.strip("（）()「」\"' ")
            if text and text not in ("沉默", "NOTHING", "無", "空", "（沉默）"):
                logger.info(f"3a: 主動說(第{n+1}次) → {text[:60]!r}")
                session.say(text)
                _itj["last_say"] = time.time()
            else:
                logger.info(f"3a: 評估後選擇沉默(第{n+1}次)")
        except Exception as e:
            logger.error(f"3a interject failed: {e}")
        _itj["nudges"] += 1
        _itj["interval"] = min(_itj["interval"] * BACKOFF, MAX_INTERVAL)
        _arm(_itj["interval"])

    @session.on("user_state_changed")
    def _on_user_state(ev):
        new = getattr(ev, "new_state", "")
        if new == "speaking":
            _cancel_timer()
            _itj["interval"] = baseline_secs
            _itj["nudges"] = 0
            _itj["quiet_since"] = time.time()
            if getattr(session, "agent_state", "") == "speaking":
                logger.info("3a: 用戶在角色說話時插話 → 讓位")
        elif new == "listening":
            if _itj["nudges"] == 0:
                _itj["quiet_since"] = time.time()
            if _itj["timer"] is None:
                _arm(_itj["interval"])

    logger.info(f"3a active: baseline={baseline_secs:.1f}s ×{BACKOFF} cap={MAX_INTERVAL:.0f}s im={im_threshold}")
