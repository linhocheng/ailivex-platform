"""
ailivex-realtime-agent v10 — v9 + 多人房三補強（回音過濾 / 講者身份 / 3a 收斂）

承 v9 的 LLM floor-gate。針對「一個焦點 AI 在一群真人裡像真人參與」補三件：

  ④ 回音過濾（地基）：角色自己的 TTS 被麥克風收回、標成「旁邊另一位」→
     高度吻合自己近期輸出 → 直接丟（不 gate、不記、不算講者、不餵判斷腦）。
     v9 實測：回音會讓角色對自己讓位、把自己的話記成別人說的 → 萬惡之源。

  ① 講者身份：逐字稿帶 speaker 標記（diarization #N / 主）；背景判斷腦兼差學名冊
     （自我介紹/被點名 → #N=名字）；gate / inner / 3a 的 context 都帶「現場有誰、誰說的」，
     角色不再把多人混成一團。

  ② 3a 收斂：一對一維持原樣（陪伴、填冷場）；多人時 3a 不因靜默就開口，
     改「只在判斷腦說我真的有話要加（want_to_speak）才講」→ 不再主持整場。

雙腦分工不變：Haiku 管判斷（gate + inner），Sonnet 4.6 管開口。
繼承 v9：floor-gate、靜默也記住、搶話、diarization、記憶收尾。
"""
import asyncio
import json
import logging
import os
import random
import re
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
from agent.multi_party import (
    strip_speaker_prefix, normalize_for_echo, is_echo, format_recent, roster_summary,
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
logger = logging.getLogger("ailivex-realtime-v10")

YIELD_SECS = 20.0      # 交棒第三方後的讓位窗：這段時間 3a 閉嘴，讓那個人講
GATE_TIMEOUT = 2.0     # LLM floor-gate 最長等待；超時 → fallback，絕不凍住回話

PROJECT_NAMESPACE = os.environ.get("PROJECT_NAMESPACE", "ailivex")

FALLBACK_PROMPT = (
    "你是一個禮貌的 AI 助手。這是即時語音通話。"
    "用簡體中文回覆（TTS 發音穩定），一兩句話，不要 stage directions。"
)


class AilivexAgentV10(Agent):
    """v10 發言權控制 + 多人房補強（回音過濾 / 講者身份 / 3a 收斂在 entrypoint）。

    yield_until：交棒第三方後的讓位截止時戳；3a 讀它，期間閉嘴。
    transcript/ctx_flags/roster/self_norms：entrypoint 傳入的引用，gate 共用。
    """

    def __init__(self, *, agent_names: list[str], anthropic_key: str,
                 transcript: list, ctx_flags: dict, roster: dict, self_norms, **kwargs):
        super().__init__(**kwargs)
        self._agent_names = agent_names
        self._anthropic_key = anthropic_key
        self._transcript = transcript        # 引用：最近逐字稿（gate 上下文）
        self._ctx_flags = ctx_flags          # 引用：{'multi_person': bool}
        self._roster = roster                # 引用：{speaker_label: name}
        self._self_norms = self_norms        # 引用：deque[(ts, norm)] 角色近期輸出（回音比對）
        self.yield_until = 0.0
        self.on_turn = None                  # entrypoint 設：每個（含靜默）user turn 後觸發判斷腦

    def _recent_self_norms(self, window: float = 25.0) -> list:
        now = time.time()
        return [n for (ts, n) in self._self_norms if now - ts <= window]

    async def _floor_gate_llm(self, text: str) -> dict | None:
        """Haiku 判斷這句的發言權歸屬。回 {'addressed': bool, 'handoff': bool}，失敗回 None。"""
        try:
            from anthropic import AsyncAnthropic
            # gate 在關鍵路徑、要快又穩 → 直連付費 key（realtime 本就用直連）。
            client = AsyncAnthropic(api_key=self._anthropic_key)
            recent = format_recent(self._transcript, self._roster, 6)   # 帶講者身份
            names = "、".join(self._agent_names) or "（未命名）"
            who = roster_summary(self._roster)
            resp = await asyncio.wait_for(client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=60,
                system=(
                    f"你是「{names}」，在一個有多個真人的語音房間裡聽大家說話。{who}\n"
                    "判斷【最後這句話】的發言權歸屬，只輸出一個 JSON，不要其他字：\n"
                    '{"addressed": true/false, "handoff": true/false}\n'
                    "addressed=true：這句在跟『你』說話、問你、邀請你開口——"
                    "即使用的是你名字的變體、暱稱、稱謂（法師/大師/老師/簡稱、簡繁體不同）也算。\n"
                    "handoff=true：明確把發言權交給『另一個人』（不是你）去說，例如點名別人講、請別人先說。\n"
                    "兩者都 false：他們在彼此對話，這句沒在跟你說、也沒交棒給特定的人。\n"
                    "你被叫到 → addressed=true、handoff=false。"
                ),
                messages=[{"role": "user", "content": f"最近對話：\n{recent}\n\n最後這句：{text}"}],
            ), timeout=GATE_TIMEOUT)
            raw = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return None
            d = json.loads(m.group(0))
            return {"addressed": bool(d.get("addressed")), "handoff": bool(d.get("handoff"))}
        except Exception as e:
            logger.warning(f"v10 floor-gate LLM failed: {e}")
            return None

    def _remember(self, new_message, speaker: str, text: str) -> None:
        """靜默時也要記住：把這句寫進兩個腦（Sonnet chat_ctx + 3a transcript），帶講者身份。
        只在『不回話』時呼叫 —— 回話時框架自己 commit，別重複。"""
        try:
            self._chat_ctx.items.append(new_message)
        except Exception as e:
            logger.warning(f"v10 remember chat_ctx failed: {e}")
        self._transcript.append({"role": "user", "content": text, "speaker": speaker})

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        raw_text = (new_message.text_content or "").strip() if new_message else ""
        if not raw_text:
            return
        speaker, text = strip_speaker_prefix(raw_text)
        if not text:
            return

        # ④ 回音過濾（地基）：這句若是角色自己近期說過的回音 → 直接丟，什麼都不做。
        #    不 gate、不記、不反應。根治「角色對自己讓位/把自己的話記成別人」。
        if is_echo(raw_text, self._recent_self_norms()):
            logger.info(f"v10 回音丟棄（speaker={speaker}）{text[:34]!r}")
            raise StopResponse

        # 快路徑：一對一（沒偵測到多人）→ 不喚 LLM，直接框架預設回話
        if not self._ctx_flags.get("multi_person"):
            return

        # 多人情境 → LLM floor-gate（Haiku 直連）。失敗 → regex fallback（保守，不亂回）。
        decision = await self._floor_gate_llm(text)
        if decision is not None:
            handoff, addressed = decision["handoff"], decision["addressed"]
            src = "LLM"
        else:
            handoff = is_floor_handoff(text, self._agent_names)
            addressed = (not handoff) and is_addressed_to_me(text, self._agent_names)
            src = "regex-fallback"

        if handoff:
            self.yield_until = time.time() + YIELD_SECS
            self._remember(new_message, speaker, text)
            if self.on_turn:
                self.on_turn()   # 靜默也要動腦：對話流過時持續重評「我有貨要加嗎」
            logger.info(f"v10 gate[{src}]：交棒第三方 → 讓位窗{YIELD_SECS:.0f}s（記住）{text[:40]!r}")
            raise StopResponse
        if addressed:
            self.yield_until = 0.0
            logger.info(f"v10 gate[{src}]：被點名 → 正常回話 {text[:44]!r}")
            return   # 框架會 commit → _on_item_added 那邊觸發判斷腦
        self._remember(new_message, speaker, text)
        if self.on_turn:
            self.on_turn()
        logger.info(f"v10 gate[{src}]：非對我（多人彼此聊）→ 靜默但記住 {text[:40]!r}")
        raise StopResponse


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

    # gate 共用狀態（引用傳進 agent）：
    # transcript 最近上下文、ctx_flags 多人 latch、roster 名冊、self_norms 角色近期輸出（回音比對）
    transcript: list = []
    ctx_flags = {"multi_person": False}
    roster: dict = {}
    self_norms: list = []   # [(ts, normalized_text)] 角色自己說過的話，供回音偵測

    # agent_names：角色名字 + 別名，用於發言權控制
    agent_names = ([char_ctx.name] + list(char_ctx.aliases or [])) if char_ctx else []
    agent = AilivexAgentV10(
        instructions=system_prompt,
        tools=[remember_tool, write_document_tool],
        agent_names=agent_names,
        anthropic_key=anthropic_key,
        transcript=transcript,
        ctx_flags=ctx_flags,
        roster=roster,
        self_norms=self_norms,
    )
    logger.info(f"Agent v10 initialized: soul={len(system_prompt)} chars, agent_names={agent_names}")

    _conv = char_ctx.conv_settings if char_ctx else {}
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=vad,
                           turn_handling=build_turn_handling(_conv))

    call_start = time.time()
    _finalize_lock = asyncio.Lock()
    _finalized = {"done": False}
    _stopped = {"v": False}   # ⑤ 斷線/收尾旗標：讓自我重排的 3a 計時器停手，不再空轉/對死 session 開火

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
        logger.info(f"v10 搶話! stance={stance} act={_inner['activation']:.2f} "
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
            logger.error(f"v10 搶話 generate_reply failed: {e}")
        # 搶完降溫，避免連環觸發
        _inner["want_to_speak"] = False
        _inner["activation"] = 0.0

    async def _run_inner_judgment():
        """判斷腦（Haiku）：讀帶講者身份的逐字稿 → 內心狀態 + 兼差學名冊。"""
        async with _inner_lock:
            labeled = format_recent(transcript, roster, 8)   # 帶講者身份
            if not labeled.strip():
                return
            # 還沒對上名字的訪客（名冊學習目標）
            unknown = sorted({t.get("speaker") for t in transcript[-8:]
                              if t.get("role") == "user" and str(t.get("speaker", "")).startswith("#")
                              and not roster.get(t.get("speaker"))})
            try:
                from anthropic import AsyncAnthropic
                _bu = os.environ.get("BRIDGE_URL", "")
                _bs = os.environ.get("BRIDGE_SECRET", "")
                if _bu and _bs:
                    client = AsyncAnthropic(api_key=_bs, base_url=_bu)
                else:
                    client = AsyncAnthropic(api_key=anthropic_key)
                model = "claude-haiku-4-5-20251001"
                name_task = (
                    f"\n名冊：對話裡若有人自我介紹或被叫名字，把訪客標記對應上。還沒對上的訪客：{unknown}。"
                    if unknown else ""
                )
                resp = await client.messages.create(
                    model=model,
                    max_tokens=260,
                    system=(
                        system_prompt
                        + "\n\n[背景判斷·只輸出 JSON] 你正在聽一場多人對話（你不一定被點名）。判斷此刻你這個角色的內心狀態。\n"
                        "⚠️ 你天生會傾向把話評成『中性、和諧』來維持氣氛——這是討好，是要克服的偏差。\n"
                        "真實有底色的人，聽到違背價值觀、邏輯有漏洞、太輕率的斷言會想頂回去；聽到精彩的點也會想接、想補。\n"
                        "只輸出一個 JSON，不要其他字：\n"
                        '{"stance":"agree|disagree|neutral","activation":0.0~1.0,'
                        '"want_to_speak":true|false,"what_to_say":"若想說，方向一句話否則空","names":{"#2":"名字"}}\n'
                        "activation = 話題觸動你想表態的程度（0=真的無感，1=強烈）。\n"
                        "want_to_speak：你**真的有話想加進這場**時 true——不只反對，也包括很認同想補一個觀點、"
                        "想接著說、想點破、想問關鍵問題。只有純閒聊、跟你毫無關係、或沒有具體可加的才 neutral+false。\n"
                        "names：只填你這次新對應上的『訪客標記→名字』，沒有就給 {}。" + name_task
                    ),
                    messages=[{"role": "user", "content": f"最近的對話（帶講者）：\n{labeled}"}],
                )
                raw = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
                new_inner = parse_inner_state(raw)
                _inner.update(new_inner)
                # 名冊學習（best-effort，學錯只是叫錯稱呼、下句可修，不致命）
                try:
                    m = re.search(r"\{.*\}", raw, re.DOTALL)
                    names = (json.loads(m.group(0)).get("names") or {}) if m else {}
                    for k, v in names.items():
                        k = str(k).strip()
                        # 清雜訊：剝括號註解（待確認/可能…）、問號；不確定的就不學
                        name = re.sub(r"[（(].*?[)）]", "", str(v)).strip(" ？?…。.") if isinstance(v, str) else ""
                        if k.startswith("#") and name and len(name) <= 12 and not roster.get(k):
                            roster[k] = name
                            logger.info(f"v10 名冊學到 {k}={name}")
                except Exception:
                    pass
                logger.info(f"v10 inner: stance={_inner['stance']} act={_inner['activation']:.2f} "
                            f"want={_inner['want_to_speak']} say={_inner['what_to_say'][:30]!r}")
            except Exception as e:
                logger.error(f"v10 inner judgment failed: {e}")
                return
        # 判斷完（鎖外）→ 檢查要不要搶話
        await _maybe_grab_floor()

    def _self_norms_recent(window: float = 25.0) -> list:
        now = time.time()
        return [n for (ts, n) in self_norms if now - ts <= window]

    def _notify_turn():
        """每個（含靜默）user turn 後：累計 + 每 INNER_EVERY 句重跑判斷腦。
        關鍵：多人時 Tracy 大多被判靜默、不提交 → 靠這個讓判斷腦跟著對話流動重跑，
        她才會持續重評『我現在有貨要加嗎』，不會卡在舊的 want_to_speak=False 變啞巴。"""
        _user_turns["count"] += 1
        # 判斷腦在跑就不疊新的（多人快節奏下避免 Haiku call 堆積）；下一次 turn 會補上
        if _user_turns["count"] % INNER_EVERY == 0 and not _inner_lock.locked():
            asyncio.create_task(_run_inner_judgment())

    agent.on_turn = _notify_turn   # 靜默 turn 由 agent 在 on_user_turn_completed 觸發

    @session.on("conversation_item_added")
    def _on_item_added(event):
        item = getattr(event, "item", None)
        if not item:
            return
        role = getattr(item, "role", "")
        raw = (getattr(item, "text_content", "") or getattr(item, "content", "") or "").strip()
        if not raw:
            return
        if role == "assistant":
            # 記下角色自己說的話（正規化）供回音偵測；修剪舊的
            self_norms.append((time.time(), normalize_for_echo(raw)))
            if len(self_norms) > 40:
                del self_norms[:-40]
            transcript.append({"role": "assistant", "content": raw})
        elif role == "user":
            speaker, clean = strip_speaker_prefix(raw)
            if not clean:
                return
            if is_echo(raw, _self_norms_recent()):   # 防禦：回音漏到這就跳過（一般已被 gate 丟）
                return
            transcript.append({"role": "user", "content": clean, "speaker": speaker})
            _notify_turn()   # 已提交（被點名/回話）的 turn 也累計 + 觸發判斷腦

    _seen_speakers: set = set()

    @session.on("user_input_transcribed")
    def _on_user_transcribed(ev):
        if getattr(ev, "is_final", False):
            sid = getattr(ev, "speaker_id", None)
            txt = getattr(ev, "transcript", "")
            # ④ 回音不算講者：自己的 TTS 被收回別誤當第二個人 → 防誤觸多人 latch
            if is_echo(txt, _self_norms_recent()):
                logger.info(f"v10 STT 回音（不算講者）→ {txt[:40]!r}")
                return
            if sid is not None:
                _seen_speakers.add(sid)
            if (len(_seen_speakers) >= 2 or "（旁邊另一位" in txt) and not ctx_flags["multi_person"]:
                ctx_flags["multi_person"] = True
                _cancel_timer()   # 多人情境下 3a 不再跑，立刻停掉現有 timer
                logger.info(f"v10 偵測到多人情境 → 啟用 LLM floor-gate，停止 3a (speakers={_seen_speakers})")
            logger.info(f"v10 STT speaker_id={sid!r} → {txt[:60]!r}")

    async def _finalize(reason: str = "") -> None:
        _stopped["v"] = True   # ⑤ shutdown 也停 3a（涵蓋沒走 room disconnected 的關閉路徑）
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
        _stopped["v"] = True   # ⑤ 斷線即停 3a：取消 timer + 讓 _maybe_interject 直接退出（不再空轉）
        try:
            _cancel_timer()
        except Exception:
            pass
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
        if _stopped["v"]:   # ⑤ 斷線/收尾 → 不再重排，3a 迴圈到此終止
            return
        # v10 讓位窗：剛把棒子交給第三方 → 3a 閉嘴，讓那個人講（不報幕）
        if time.time() < agent.yield_until:
            _arm(max(2.0, agent.yield_until - time.time()))
            return
        if session.current_speech is not None or getattr(session, "agent_state", "") == "speaking":
            _arm(2.5)
            return
        if time.time() - _itj["last_say"] < MIN_GAP:
            _arm(MIN_GAP)
            return
        # ② 多人：3a 完全不跑。冷場填補不是群聊裡 AI 的責任；兩個 AI 同時有 3a 會互相打架。
        #    多人時 AI 只靠 gate（被點名才回）+ inner（有貨才主動）。
        if ctx_flags.get("multi_person"):
            return  # 不重排，3a 迴圈在多人情境徹底停止
        quiet_for = int(time.time() - _itj["quiet_since"])
        n = _itj["nudges"]
        logger.info(f"3a: 評估主動開口 (第{n+1}次, 已靜默{quiet_for}s, interval={_itj['interval']:.0f}s, im={im_threshold})")
        try:
            from anthropic import AsyncAnthropic
            recent = format_recent(transcript, roster, 6) or "（還沒有對話）"
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
            if _itj["timer"] is None and not ctx_flags.get("multi_person"):
                _arm(_itj["interval"])

    logger.info(f"3a active: baseline={baseline_secs:.1f}s ×{BACKOFF} cap={MAX_INTERVAL:.0f}s im={im_threshold}")
