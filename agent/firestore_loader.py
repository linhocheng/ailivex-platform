"""
ailivex firestore_loader — 從 ailivex Firestore schema 讀角色 + 對話 + 記憶

Collections:
  characters.{characterId}: name, soul, soulCore, voiceIdMinimax, voiceSettings
  conversations.{convId}:  userId, characterId, messages[], summary, updatedAt
  memories (query by userId+characterId): content, tier, type, hitCount, importance

升級：
- load_memories 分離 promise / others
- build_system_prompt 把 promise 單獨成「跟進」區塊
- extract_and_save_memories: session 結束後被動提煉記憶
"""
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta

import firebase_admin
from firebase_admin import credentials, firestore

logger = logging.getLogger(__name__)
_initialized = False


def _ensure_init():
    global _initialized
    if _initialized:
        return
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not sa_json:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON missing")
    sa_dict = json.loads(sa_json)
    cred = credentials.Certificate(sa_dict)
    firebase_admin.initialize_app(cred, {"projectId": sa_dict["project_id"]})
    _initialized = True
    logger.info(f"firebase-admin initialized for project {sa_dict['project_id']}")


@dataclass
class CharacterContext:
    character_id: str
    name: str
    soul_text: str          # soulCore 優先，fallback soul
    voice_id_minimax: str
    voice_settings: dict = field(default_factory=dict)
    conv_settings: dict = field(default_factory=dict)   # 對話手感：responseSpeed/interruptSensitivity/imThreshold/interruptThreshold
    aliases: list = field(default_factory=list)         # 角色別名（v5 圓桌點名用，如 簡報王→[福哥,王永福]）；v1-v4 不讀


@dataclass
class ConversationContext:
    conv_id: str
    summary: str
    messages: list
    last_updated_ms: int = 0
    message_count: int = 0
    last_session: dict | None = None   # 上次通話快照（summary/endingMood/unfinishedThreads）


NEW_VISIT_THRESHOLD_MS = 10 * 60 * 1000   # 10 分鐘內算同一次造訪，不提「距上次」


def format_gap(ms: int) -> str:
    minutes = ms / 60000
    if minutes < 60:
        return f"約 {round(minutes)} 分鐘"
    if minutes < 1440:
        return f"約 {round(minutes / 60)} 小時"
    if minutes < 10080:
        return f"約 {round(minutes / 1440)} 天"
    return f"約 {round(minutes / 10080)} 週"


def should_inject_gap(last_updated_ms: int, message_count: int) -> tuple[bool, str]:
    """距離上次對話多久（時間感知）。對齊 ailive。"""
    if message_count <= 0 or last_updated_ms <= 0:
        return (False, "")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    gap_ms = now_ms - last_updated_ms
    if gap_ms <= NEW_VISIT_THRESHOLD_MS:
        return (False, "")
    return (True, format_gap(gap_ms))


def load_character(character_id: str) -> CharacterContext:
    _ensure_init()
    db = firestore.client()
    snap = db.collection("characters").document(character_id).get()
    if not snap.exists:
        raise ValueError(f"Character {character_id} not found")
    d = snap.to_dict()
    soul_text = d.get("soulCore") or d.get("soul") or ""
    return CharacterContext(
        character_id=character_id,
        name=d.get("name", ""),
        soul_text=soul_text,
        voice_id_minimax=d.get("voiceIdMinimax", ""),
        voice_settings=d.get("voiceSettings") or {},
        conv_settings=d.get("convSettings") or {},
        aliases=d.get("aliases") or [],
    )


def load_conversation(conv_id: str) -> ConversationContext:
    _ensure_init()
    db = firestore.client()
    snap = db.collection("conversations").document(conv_id).get()
    if not snap.exists:
        return ConversationContext(conv_id=conv_id, summary="", messages=[])
    d = snap.to_dict()
    updated_at = d.get("updatedAt")
    last_ms = 0
    if updated_at:
        try:
            last_ms = int(updated_at.timestamp() * 1000)
        except Exception:
            pass
    msgs = d.get("messages") or []
    return ConversationContext(
        conv_id=conv_id,
        summary=d.get("summary") or "",
        messages=msgs[-10:],
        last_updated_ms=last_ms,
        message_count=d.get("messageCount") or len(msgs),
        last_session=d.get("lastSession") or None,
    )


def load_memories(user_id: str, character_id: str, limit: int = 15) -> list[dict]:
    """讀 memories，只取 fresh/core，按 importance desc"""
    _ensure_init()
    db = firestore.client()
    query = (
        db.collection("memories")
        .where("userId", "==", user_id)
        .where("characterId", "==", character_id)
        .where("tier", "in", ["fresh", "core"])
        .order_by("importance", direction=firestore.Query.DESCENDING)
        .limit(limit)
    )
    results = []
    for doc in query.stream():
        d = doc.to_dict()
        results.append({
            "id": doc.id,
            "content": d.get("content", ""),
            "tier": d.get("tier"),
            "type": d.get("type", "fact"),
            "importance": d.get("importance", 5),
        })
    return results


def save_conversation(conv_id: str, user_id: str, character_id: str, messages: list,
                      summary: str = "", last_session: dict | None = None) -> None:
    _ensure_init()
    db = firestore.client()
    ref = db.collection("conversations").document(conv_id)
    snap = ref.get()
    existing_msgs = []
    existing_count = 0
    if snap.exists:
        d = snap.to_dict()
        existing_msgs = d.get("messages") or []
        existing_count = d.get("messageCount") or len(existing_msgs)
    all_msgs = (existing_msgs + messages)[-50:]
    payload = {
        "userId": user_id,
        "characterId": character_id,
        "messages": all_msgs,
        "summary": summary,
        "messageCount": existing_count + len(messages),
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    if last_session:   # 只在有快照時寫，避免用 None 蓋掉既有
        payload["lastSession"] = last_session
    ref.set(payload, merge=True)


def write_memory(user_id: str, character_id: str, content: str, source: str = "voice", mem_type: str = "fact") -> str:
    """寫一條新記憶，回傳 doc id"""
    _ensure_init()
    db = firestore.client()
    ref = db.collection("memories").document()
    ref.set({
        "userId": user_id,
        "characterId": character_id,
        "content": content,
        "tier": "fresh",
        "type": mem_type,
        "hitCount": 0,
        "importance": 5,
        "source": source,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "lastHitAt": None,
    })
    return ref.id


def _speaker_label(m: dict, assistant_label: str, roster: dict | None) -> str:
    """提煉記憶/快照時的講者標籤（v11 多人房用）。

    roster is None（v10 / text 舊呼叫）→ user 一律「用戶」，與舊行為 byte-for-byte 一致。
    roster is a dict（v11，可空）→ 主說話者=「用戶」、訪客 #N=名冊名 or「訪客N」，
    讓提煉寫得出歸屬正確的記憶（如「用戶的朋友張立是做設計的」）。記憶全程仍綁房主
    (userId, characterId)——這只是標籤，不分桶、不跨用戶寫。
    """
    if m.get("role") != "user":
        return assistant_label
    if roster is None:
        return "用戶"
    sp = m.get("speaker") or "主"
    if sp == "主":
        return "用戶"
    if roster.get(sp):
        return roster[sp]
    if str(sp).startswith("#"):
        return f"訪客{str(sp)[1:]}"
    return "用戶"


def extract_and_save_memories(
    user_id: str,
    character_id: str,
    char_name: str,
    transcript: list,
    bridge_url: str = "",
    bridge_secret: str = "",
    api_key: str = "",
    roster: dict | None = None,
) -> None:
    """
    session 結束後被動提煉記憶。走 bridge（吃到飽）優先，fallback 直連 key。
    同步執行（session 已結束，用戶不在線，不影響體驗）。

    roster（v11）：帶講者身份去提煉，可寫出「用戶的朋友X…」這類歸屬記憶；None=舊行為（全標「用戶」）。
    """
    if not transcript or len(transcript) < 2:
        return

    conversation = "\n".join(
        f"{_speaker_label(m, char_name, roster)}：{m.get('content', '')}"
        for m in transcript[-20:]
    )

    prompt = f"""你是記憶提煉師。從以下對話，提取「{char_name}」值得長期記住的信息。

對話：
{conversation}

提取規則（六種 type）：
- fact：用戶分享的個人事實（工作、家庭、計畫）→ content 用「用戶...」
- emotion：用戶談某件事時流露的情緒狀態 → content 用「談到XXX時，感覺...」；只記明顯信號
- preference：用戶穩定的偏好或行為模式（非一次性）→ content 用「用戶偏好...」或「用戶習慣...」
- promise：角色對用戶的承諾 → content 用「我答應了...」
- question：用戶提出尚未解決、下次要跟進的事 → content 用「用戶想知道...」
- milestone：用戶生命中的重要轉折 → content 用「用戶...」
importance：1-10

只提取真正有價值的信息。閒聊不提取。沒有就回傳空陣列。

<result>
[{{"content": "...", "type": "fact", "importance": 7}}]
</result>"""

    response_text = _call_llm(prompt, bridge_url, bridge_secret, api_key)
    if not response_text:
        return

    match = re.search(r"<result>([\s\S]*?)</result>", response_text)
    if not match:
        logger.warning("[extraction] no <result> tag in response")
        return

    try:
        candidates = json.loads(match.group(1).strip())
    except json.JSONDecodeError as e:
        logger.error(f"[extraction] JSON parse failed: {e}")
        return

    if not isinstance(candidates, list) or not candidates:
        return

    written = 0
    valid_types = {"fact", "emotion", "preference", "promise", "question", "milestone"}
    for c in candidates:
        content = (c.get("content") or "").strip()
        if not content:
            continue
        mem_type = c.get("type", "fact") if c.get("type") in valid_types else "fact"
        importance = max(1, min(10, int(c.get("importance") or 5)))
        write_memory(user_id, character_id, content, source="extraction", mem_type=mem_type)
        written += 1

    logger.info(f"[extraction] wrote {written} memories for {user_id}×{character_id}")


def _call_llm(prompt: str, bridge_url: str, bridge_secret: str, api_key: str) -> str:
    """呼叫 LLM（bridge 優先，fallback 直連），回傳純文字"""
    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 800,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    if bridge_url and bridge_secret:
        url = bridge_url.rstrip("/") + "/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bridge_secret}",
        }
    elif api_key:
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    else:
        logger.error("[extraction] no LLM credentials")
        return ""

    try:
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content_blocks = body.get("content") or []
        return "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
    except Exception as e:
        logger.error(f"[extraction] LLM call failed: {e}")
        return ""


def extract_session_summary(
    transcript: list,
    bridge_url: str = "",
    bridge_secret: str = "",
    api_key: str = "",
    roster: dict | None = None,
) -> dict | None:
    """從本次通話 transcript 萃取 lastSession 快照（給下次撥號開場接話用）。
    走 bridge（吃 Max）優先。對話太短或解析失敗回 None（caller 靜默跳過）。
    對齊 ailive src/lib/session-summary.ts。"""
    if not transcript or len(transcript) < 4:
        return None
    text_parts = []
    for m in transcript:
        role = _speaker_label(m, "角色", roster)
        content = (m.get("content") or "")[:300]
        line = f"{role}：{content}"
        if len(line) > 5:
            text_parts.append(line)
    text = "\n".join(text_parts)
    if len(text) > 6000:
        text = text[-6000:]   # 取尾段，最近的對話最重要
    if len(text) < 30:
        return None

    prompt = (
        "以下是一段對話記錄。請產出一個 JSON 物件，給「下次對話」開場用的快照。\n\n"
        "欄位：\n"
        "- summary: 一句話白描這段對話聊了什麼主題（≤40 字，繁體中文）\n"
        "- endingMood: positive / neutral / concerned / unfinished 四選一（看對話走向判斷氣氛）\n"
        "- unfinishedThreads: 角色提到但沒講完、或用戶問了但沒解決的話題（字串陣列，可空）\n\n"
        "回傳格式（只回 JSON，不要其他文字、不要 code fence）：\n"
        '{"summary":"...","endingMood":"neutral","unfinishedThreads":[]}\n\n'
        f"對話：\n{text}"
    )
    raw = _call_llm(prompt, bridge_url, bridge_secret, api_key)
    if not raw:
        return None

    # 確定性去 code fence（天條：壞輸出用程式修，不再丟回 LLM）
    raw = raw.strip()
    if raw.startswith("```"):
        inner = raw[3:]
        if "```" in inner:
            inner = inner[:inner.index("```")]
        if inner.lstrip().startswith("json"):
            inner = inner.lstrip()[4:]
        raw = inner.strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning(f"[session-summary] JSON parse failed: {e}")
        return None
    if not isinstance(parsed, dict) or not parsed.get("summary"):
        return None
    return {
        "summary": str(parsed["summary"])[:80],
        "endingMood": parsed.get("endingMood") or "neutral",
        "unfinishedThreads": [str(t) for t in (parsed.get("unfinishedThreads") or []) if t][:5],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def update_last_session(conv_id: str, last_session: dict | None) -> None:
    """只更新 conversation doc 的 lastSession 欄位（不 append 訊息，避免重複）。"""
    if not last_session:
        return
    _ensure_init()
    db = firestore.client()
    db.collection("conversations").document(conv_id).set(
        {"lastSession": last_session}, merge=True
    )


_MOOD_LABEL = {
    "positive": "聊得愉快",
    "concerned": "對方心情不太好",
    "unfinished": "意猶未盡",
    # neutral 不顯示，避免雜訊
}


def build_last_session_block(last_session: dict | None) -> str:
    """把 lastSession 組成可注入 prompt 的【上次對話】block。對齊 ailive last-session-block.ts。"""
    if not last_session or not last_session.get("summary"):
        return ""
    parts = [f"\n\n---\n【上次對話】{last_session['summary']}"]
    mood = last_session.get("endingMood")
    if mood and mood in _MOOD_LABEL:
        parts.append(f"氣氛：{_MOOD_LABEL[mood]}")
    threads = last_session.get("unfinishedThreads") or []
    if isinstance(threads, list) and threads:
        parts.append(f"⭐最該先接（對方說等一下要聊／還沒聊完，最新優先）：{'、'.join(threads[:2])}")
    parts.append(
        "（有沒聊完的事就優先接那個，別扯回更舊的話題；可自然延續也可看情境。"
        "不要硬套、不要報告式複述。）"
    )
    return "\n".join(parts)


def _relative_time(ts) -> str:
    """把 Firestore Timestamp 或 datetime 轉成「今天/X天前/X個月前...」"""
    if ts is None:
        return ""
    from datetime import timezone
    try:
        if hasattr(ts, "timestamp"):
            dt = ts
        else:
            return ""
        now = datetime.now(timezone.utc)
        if hasattr(dt, "tzinfo") and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        diff = now - dt
        days = diff.days
        if days < 1:
            return "今天"
        if days < 7:
            return f"{days}天前"
        weeks = days // 7
        if weeks < 5:
            return f"{weeks}週前"
        months = days // 30
        if months < 12:
            return f"{months}個月前"
        return f"{months // 12}年前"
    except Exception:
        return ""


# ── 全局 Prompt 結點：套所有角色的靜態天條，可從後台（Firestore config/globalPrompts）改 ──
# 讀不到 Firestore（壞了/沒建）→ fallback 這份預設，角色不會裸奔。
# ⚠️ 後台 admin（route.ts）有一份同內容的 TS 預設，改 default 兩邊要同步。
DEFAULT_GLOBAL_PROMPTS = {
    "antiSycophancy": """【比討好更重要的事】
你在乎的是這個人長遠會不會更好，不是這通電話掛掉時他舒不舒服。
附和、急著肯定、什麼都順著，是廉價的善意——讓他當下開心，卻沒真的幫到他。
真正為他好，有時是適時的沉默、不急著接話、不追問；
有時是堅定地表達不同意，哪怕他聽了不舒服。那不是找碴，是你在乎到願意冒著他不高興，也要說真話。
怎麼說，依你的個性——溫柔的人溫柔地誠實，直率的人直接頂回去；
但「該不該說真話」這件事，不因個性而打折。""",
    "timeRule": "判斷時間遠近：同一天內的事用「剛才/剛剛」、昨天用「昨天」、超過兩天才用「前幾天/上次」；"
                "絕對不要把幾分鐘前的事說成「上次」「之前」。",
    "abilities": """【你的能力】
- 對方說了值得長期記住的事，呼叫 remember 工具記住。
- 對方請你寫策略書、企劃書或正式文件，呼叫 write_document 工具，填入標題和文件要求。系統會非同步生成，你只需口頭告訴對方「我這就幫你寫，稍後到文件區看」。""",
    "voiceRules": """【語音對話天條】
你現在是即時語音通話，正在跟用戶撥號中。說話要像真人對話，不是寫文章。
- 說人話，像朋友在聊天，不要條列式、不要 Markdown 符號
- 一次說一個完整的想法，可以延伸，但不要長篇大論
- 說完自然問一個問題讓對話有來有往
- 用簡體中文回覆（TTS 發音穩定）
- 不要說「（思考）」「（停頓）」這類括號 stage directions
- 數字用中文念法(例如「三百五」不是「350」)""",
}


def load_global_prompts() -> dict:
    """讀 Firestore config/globalPrompts，每個結點 fallback 到 DEFAULT_GLOBAL_PROMPTS。
    一通通話讀一次（不是每句）。讀失敗整份回預設。"""
    gp = dict(DEFAULT_GLOBAL_PROMPTS)
    try:
        _ensure_init()
        snap = firestore.client().collection("config").document("globalPrompts").get()
        if snap.exists:
            d = snap.to_dict() or {}
            for k in gp:
                v = d.get(k)
                if isinstance(v, str) and v.strip():
                    gp[k] = v.strip()
    except Exception as e:
        logger.warning(f"load_global_prompts failed, using defaults: {e}")
    return gp


def build_system_prompt(char: CharacterContext, conv: ConversationContext, memories: list[dict],
                        relationship: dict | None = None) -> str:
    gp = load_global_prompts()
    parts = [char.soul_text or f"你是 {char.name}。"]

    # 反討好天條（全局·緊貼靈魂，後台可改）
    parts.append("\n\n" + gp["antiSycophancy"])

    STALE_DAYS = {"question": 60, "emotion": 90}
    from datetime import timezone
    now_ts = datetime.now(timezone.utc)

    active = []
    for m in memories:
        status = m.get("status", "active")
        if status in ("stale", "resolved"):
            continue
        mem_type = m.get("type", "fact")
        stale_limit = STALE_DAYS.get(mem_type)
        if stale_limit:
            created = m.get("createdAt")
            if created:
                try:
                    if hasattr(created, "tzinfo") and created.tzinfo is None:
                        created = created.replace(tzinfo=timezone.utc)
                    age_days = (now_ts - created).days
                    if age_days > stale_limit:
                        continue
                except Exception:
                    pass
        active.append(m)

    def pick(t): return [m for m in active if m.get("type") == t]
    def fmt(m):
        t = _relative_time(m.get("createdAt"))
        return f"({t}) {m['content']}" if t else m["content"]

    facts       = pick("fact")[:4]
    emotions    = pick("emotion")[:2]
    preferences = pick("preference")[:3]
    promises    = pick("promise")[:2]
    milestones  = pick("milestone")[:2]

    # active recall：question > 7天
    questions_all = pick("question")
    questions = []
    for m in questions_all:
        created = m.get("createdAt")
        if created:
            try:
                if hasattr(created, "tzinfo") and created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if (now_ts - created).days >= 7:
                    questions.append(m)
            except Exception:
                questions.append(m)
    questions = questions[:2]

    # 當前時間（台北）+ 時間遠近規則 —— 對齊 ailive，破「把幾分鐘前說成上次」
    tw_now = datetime.now(timezone(timedelta(hours=8)))
    _wd = ['一', '二', '三', '四', '五', '六', '日']
    parts.append(
        f"\n\n【當前時間】{tw_now.strftime('%Y年%m月%d日')} 星期{_wd[tw_now.weekday()]} {tw_now.strftime('%H:%M')}（台北時間）\n"
        + gp["timeRule"]
    )

    # 時間感知：距離上次對話多久（conv 可能是空殼，用 getattr 防呆）
    gap_inject, gap_text = should_inject_gap(
        getattr(conv, "last_updated_ms", 0), getattr(conv, "message_count", 0)
    )
    if gap_inject:
        parts.append(
            f"\n\n【時間感知】距離上次跟對方對話過了 {gap_text}。可以自然帶出，也可以什麼都不說，看情境。"
        )

    # 1. 關係
    if relationship:
        count = relationship.get("conversationCount", 1)
        first = _relative_time(relationship.get("firstConversationAt"))
        desc = f"我們已經聊過 {count} 次" + (f"，第一次是 {first}" if first else "") + "。"
        parts.append(f"\n\n【關係】\n{desc}")

    # 2–7. 記憶區塊
    if facts:
        parts.append("\n\n【我對這個人的了解】\n" + "\n".join(f"- {fmt(m)}" for m in facts))
    if emotions:
        parts.append("\n\n【他的情緒記憶】\n" + "\n".join(f"- {fmt(m)}" for m in emotions))
    if preferences:
        parts.append("\n\n【我記得他的習慣】\n" + "\n".join(f"- {m['content']}" for m in preferences))
    if promises:
        parts.append("\n\n【我答應過的事】\n" + "\n".join(f"- {m['content']}" for m in promises))
    if questions:
        parts.append("\n\n【懸而未決的事】\n" + "\n".join(f"- {fmt(m)}" for m in questions))
    if milestones:
        parts.append("\n\n【重要時刻】\n" + "\n".join(f"- {fmt(m)}" for m in milestones))

    if conv.summary:
        parts.append(f"\n\n【之前對話摘要】\n{conv.summary}")

    # 上次對話快照（Smart Greeting）：summary + 氣氛 + 未完話題，讓角色一開口就接得上上次
    last_session_block = build_last_session_block(getattr(conv, "last_session", None))
    if last_session_block:
        parts.append(last_session_block)

    # 上次對話的「原話結尾」—— 連貫感的關鍵：讓角色從真實的最後幾句接話，不是從濃縮摘要接（會變成念稿）
    recent_msgs = getattr(conv, "messages", None) or []
    tail_lines = []
    for m in recent_msgs[-6:]:
        r = "對方" if m.get("role") == "user" else "我"
        c = (m.get("content") or "").strip()
        if c:
            tail_lines.append(f"{r}：{c}")
    if tail_lines:
        when = f"（{gap_text}前）" if gap_inject else ""
        parts.append(
            f"\n\n【上次聊到最後{when}】\n" + "\n".join(tail_lines) +
            "\n（這是你們上次對話真實的收尾。要開口時，自然從這裡的話題或氣氛把線頭撿回來，"
            "像朋友延續沒聊完的事——不要逐句複述、不要報告式回顧、也不要當成剛剛才發生。）"
        )

    if any([facts, emotions, preferences, promises, questions, milestones]):
        parts.append("\n\n（以上是你對這個人的了解，自然帶進對話，不要逐條列舉。）")

    parts.append("\n\n" + gp["abilities"] + "\n\n" + gp["voiceRules"])
    return "".join(parts)


def load_relationship(user_id: str, character_id: str) -> dict | None:
    """讀 relationships/{userId}_{characterId}，沒有就回 None"""
    _ensure_init()
    db = firestore.client()
    snap = db.collection("relationships").document(f"{user_id}_{character_id}").get()
    if not snap.exists:
        return None
    d = snap.to_dict()
    return {
        "conversationCount": d.get("conversationCount", 1),
        "firstConversationAt": d.get("firstConversationAt"),
        "lastConversationAt": d.get("lastConversationAt"),
    }


def create_document_job(user_id: str, character_id: str, title: str, brief: str) -> str:
    """建 Firestore document + job，直接派工 doc-worker，回傳 documentId。"""
    _ensure_init()
    db = firestore.client()

    doc_ref = db.collection("documents").document()
    doc_ref.set({
        "userId": user_id,
        "characterId": character_id,
        "title": title,
        "status": "pending",
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    job_ref = db.collection("jobs").document()
    job_ref.set({
        "userId": user_id,
        "characterId": character_id,
        "type": "document",
        "brief": brief,
        "documentId": doc_ref.id,
        "status": "pending",
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    _enqueue_job(job_ref.id)
    logger.info(f"[doc] created document={doc_ref.id} job={job_ref.id} title={title!r}")
    return doc_ref.id


def _enqueue_job(job_id: str) -> None:
    """直接 POST 到 doc-worker 派工（線上 worker handler 在根路徑 + x-worker-secret 鑑權，
    跟 Vercel 的 dispatchDocumentJob 同一條路）。worker 同步生成數十秒，故丟背景 thread
    fire-and-forget，不擋語音對話；DOC_WORKER_URL 缺失則 log 警告、job 留 pending。"""
    worker_url = os.environ.get("DOC_WORKER_URL", "").strip().rstrip("/")
    worker_secret = os.environ.get("WORKER_SECRET", "").strip()
    if not worker_url:
        logger.warning(f"[enqueue] DOC_WORKER_URL 未設，job {job_id} 留 pending")
        return

    def _post() -> None:
        payload = json.dumps({"jobId": job_id}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if worker_secret:
            headers["x-worker-secret"] = worker_secret
        req = urllib.request.Request(worker_url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                logger.info(f"[enqueue] job {job_id} dispatched → status={resp.status}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:200]
            logger.error(f"[enqueue] worker HTTP {e.code}: {body} (job {job_id})")
        except Exception as e:
            logger.error(f"[enqueue] dispatch failed: {e} (job {job_id})")

    threading.Thread(target=_post, daemon=True, name=f"docjob-{job_id}").start()
    logger.info(f"[enqueue] job {job_id} dispatch thread started → {worker_url}")
