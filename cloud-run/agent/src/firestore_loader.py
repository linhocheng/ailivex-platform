"""
ailiveX Firestore loader — 讀 ailivex 資料模型

Collections:
  characters/{characterId}          → name, soulCore, soul, voiceIdMinimax
  conversations/{convId}            → userId, characterId, messages[], summary, messageCount
  memories/                         → userId, characterId, content, importance, tier, hitCount
"""
import json
import logging
import os
from dataclasses import dataclass
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
    if not firebase_admin.apps:
        firebase_admin.initialize_app(cred, {"projectId": sa_dict["project_id"]})
    _initialized = True
    logger.info(f"firebase-admin initialized for project {sa_dict['project_id']}")


@dataclass
class CharacterContext:
    character_id: str
    name: str
    soul_text: str
    voice_id_minimax: str


@dataclass
class ConversationContext:
    conv_id: str
    summary: str
    messages: list
    message_count: int = 0
    last_updated_ms: int = 0


def load_character(character_id: str) -> CharacterContext:
    _ensure_init()
    db = firestore.client()
    doc = db.collection("characters").document(character_id).get()
    if not doc.exists:
        raise ValueError(f"character {character_id} not found")
    d = doc.to_dict() or {}
    soul_text = d.get("soulCore") or d.get("soul") or ""
    return CharacterContext(
        character_id=character_id,
        name=d.get("name") or character_id,
        soul_text=soul_text,
        voice_id_minimax=d.get("voiceIdMinimax") or "",
    )


def load_conversation(conv_id: str) -> ConversationContext:
    _ensure_init()
    db = firestore.client()
    doc = db.collection("conversations").document(conv_id).get()
    if not doc.exists:
        return ConversationContext(conv_id=conv_id, summary="", messages=[])
    d = doc.to_dict() or {}
    msgs = (d.get("messages") or [])[-10:]
    last_ms = 0
    raw = d.get("updatedAt")
    if raw:
        try:
            if isinstance(raw, str):
                last_ms = int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
            elif hasattr(raw, "timestamp"):
                last_ms = int(raw.timestamp() * 1000)
        except Exception:
            pass
    return ConversationContext(
        conv_id=conv_id,
        summary=d.get("summary") or "",
        messages=msgs,
        message_count=int(d.get("messageCount") or 0),
        last_updated_ms=last_ms,
    )


def load_memory_block(user_id: str, character_id: str) -> str:
    """讀 memories 集合（userId × characterId），組成記憶段落注入 system prompt"""
    _ensure_init()
    db = firestore.client()
    try:
        snap = (
            db.collection("memories")
            .where("userId", "==", user_id)
            .where("characterId", "==", character_id)
            .limit(20)
            .get()
        )
        items = []
        for doc in snap:
            d = doc.to_dict() or {}
            if d.get("tier") == "archive":
                continue
            items.append(d)

        if not items:
            return ""

        # 按 importance desc, hitCount desc
        items.sort(key=lambda x: (int(x.get("importance") or 1), int(x.get("hitCount") or 0)), reverse=True)
        items = items[:5]
        lines = [f"- {d.get('content', '')[:120]}" for d in items if d.get("content")]
        if not lines:
            return ""
        return "【我對這個人的記憶】\n" + "\n".join(lines)
    except Exception as e:
        logger.warning(f"load_memory_block failed: {e}")
        return ""


def save_conversation(
    conv_id: str,
    user_id: str,
    character_id: str,
    new_messages: list,
    transcript_summary: str = "",
) -> None:
    """通話結束後 append transcript 進 conversations doc"""
    if not new_messages:
        return
    _ensure_init()
    db = firestore.client()
    ref = db.collection("conversations").document(conv_id)
    doc = ref.get()
    existing = doc.to_dict() or {} if doc.exists else {}
    existing_messages = existing.get("messages") or []
    existing_count = int(existing.get("messageCount") or 0)
    existing_summary = existing.get("summary") or ""

    merged = existing_messages + new_messages
    new_count = existing_count + len(new_messages)
    new_summary = existing_summary

    # 壓縮：超過 10 條把舊的接進 summary（簡版，不再呼叫 LLM 壓縮）
    if len(merged) > 10:
        if transcript_summary:
            new_summary = (existing_summary + "\n" + transcript_summary if existing_summary else transcript_summary)[-800:]
        merged = merged[-10:]

    ref.set({
        "userId": user_id,
        "characterId": character_id,
        "messages": merged,
        "messageCount": new_count,
        "summary": new_summary,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    logger.info(f"conversation saved: conv_id={conv_id} appended={len(new_messages)} total={len(merged)}")


def save_voice_memory(user_id: str, character_id: str, content: str) -> None:
    """通話結束後寫一條 memory（無 embedding，語音端精簡版）"""
    if not content or not content.strip():
        return
    _ensure_init()
    db = firestore.client()
    db.collection("memories").add({
        "userId": user_id,
        "characterId": character_id,
        "content": content.strip(),
        "importance": 2,
        "tier": "fresh",
        "hitCount": 0,
        "lastHitAt": None,
        "source": "voice_conversation",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    logger.info(f"memory saved for user={user_id} char={character_id}")


NEW_VISIT_THRESHOLD_MS = 10 * 60 * 1000


def should_inject_gap(last_ms: int, msg_count: int) -> tuple[bool, str]:
    if msg_count <= 0 or last_ms <= 0:
        return False, ""
    gap_ms = int(datetime.now(timezone.utc).timestamp() * 1000) - last_ms
    if gap_ms <= NEW_VISIT_THRESHOLD_MS:
        return False, ""
    minutes = gap_ms / 60000
    if minutes < 60:
        text = f"約 {round(minutes)} 分鐘"
    elif minutes < 1440:
        text = f"約 {round(minutes / 60)} 小時"
    elif minutes < 10080:
        text = f"約 {round(minutes / 1440)} 天"
    else:
        text = f"約 {round(minutes / 10080)} 週"
    return True, text


def build_system_prompt(char: CharacterContext, conv: ConversationContext, memory_block: str) -> str:
    tw_tz = timezone(timedelta(hours=8))
    now = datetime.now(tw_tz)
    weekday = ['一', '二', '三', '四', '五', '六', '日'][now.weekday()]
    time_str = now.strftime(f"%Y年%m月%d日 星期{weekday} %H:%M")

    parts = [char.soul_text]

    parts.append("""
【語音對話天條】
你現在是即時語音通話。說話要像真人對話，不是寫文章。
- 說人話，像朋友在聊天，不要條列式、不要 Markdown 符號
- 一次說一個完整的想法，說完自然問一個問題讓對話有來有往
- 用繁體中文回覆
- 不要說「（思考）」「（停頓）」這類括號 stage directions
- 數字用中文念法（「三百五」不是「350」）

【記憶系統】
你有跨次對話的持續記憶。下方帶有「對話摘要」和「最近對話」讓你接續。
- 用戶的名字、說過的具體事、你做過的承諾，主動帶進對話展現連續性
- 禁止說「我每次對話都是新的開始」「我沒有長期記憶」

【STT 容錯】
根據上下文猜用戶意圖，就算聽起來不通順也猜。用自然方式回應，不要說「我沒聽清楚」。""")

    parts.append(f"\n【當前時間】{time_str}（台北時間）")

    gap_inject, gap_text = should_inject_gap(conv.last_updated_ms, conv.message_count)
    if gap_inject:
        parts.append(f"\n【時間感知】距離上次對話過了 {gap_text}。可以自然帶出，也可以什麼都不說。")

    if memory_block:
        parts.append(f"\n{memory_block}")

    if conv.summary:
        parts.append(f"\n【對話摘要（更早對話的精華）】\n{conv.summary}")

    if conv.messages:
        lines = []
        for m in conv.messages:
            role = m.get("role", "")
            content = (m.get("content") or "")[:400]
            if not content.strip():
                continue
            speaker = "用戶" if role == "user" else "你"
            lines.append(f"{speaker}：{content}")
        if lines:
            parts.append(f"\n【最近 {len(lines)} 條對話】\n" + "\n".join(lines))

    return "\n".join(parts)
