"""
即時語音「讀網址」工作臺 —— Phase 1 walking skeleton（不含 RAG 持久化）。

流程（前端 RPC 'share_source' 觸發）：
  暫停聽(set_audio_enabled False + interrupt) → [靜默讀取] → 抓網址正文(Vercel /api/voice-source)
  → 摘要(Sonnet) → 注入角色 instructions(update_instructions) → 恢復聽 → 角色主動開口說讀到什麼。

  RPC 立即回傳（fire-and-forget），不 block RPC timeout；後台跑完才開口。

紀律：
  - 新檔，不 import 進任何既有版本（append-only）；只在 v12 接線。
  - 抓取的 SSRF 防護複用 TS url-reader（agent 不重寫安全邏輯），這裡只負責編排 + 摘要 + 注入。
  - 確定性的部分（暫停/恢復/HTTP/JSON）走程式；只有「摘要」丟 LLM。
"""
import asyncio
import json
import logging
import os
import urllib.request
import urllib.error

logger = logging.getLogger("ailivex-source-intake")

MAX_TEXT_CHARS = 50_000   # 傳給 Sonnet 的正文上限
FETCH_TIMEOUT = 30        # Vercel /api/voice-source HTTP timeout（秒）


def _fetch_source_sync(url: str) -> dict:
    """POST Vercel /api/voice-source 抓乾淨正文。確定性，跑在 thread。回 dict（含 ok）。"""
    platform_url = os.environ.get("PLATFORM_URL", "").strip().rstrip("/")
    worker_secret = os.environ.get("WORKER_SECRET", "").strip()
    if not platform_url:
        return {"ok": False, "error": "PLATFORM_URL 未設"}
    payload = json.dumps({"url": url}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if worker_secret:
        headers["x-worker-secret"] = worker_secret
    req = urllib.request.Request(f"{platform_url}/api/voice-source", data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _summarize(title: str, text: str) -> str:
    """把抓到的正文摘要成角色「讀到了什麼」的精煉 digest。LLM 判斷題，bridge 優先。"""
    from anthropic import AsyncAnthropic
    bridge_url = os.environ.get("BRIDGE_URL", "").strip()
    bridge_secret = os.environ.get("BRIDGE_SECRET", "").strip()
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if bridge_url and bridge_secret:
        client = AsyncAnthropic(api_key=bridge_secret, base_url=bridge_url)
    else:
        client = AsyncAnthropic(api_key=anthropic_key)
    resp = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1500,
        system=(
            "你在幫一個語音角色快速消化一篇網頁，提煉成它『讀過後記在腦裡』的重點。"
            "用 6-10 句中文，講清楚這篇在談什麼、最關鍵的幾個點、值得討論的地方。"
            "只輸出重點本身，不要前言、不要客套。"
        ),
        messages=[{"role": "user", "content": f"標題：{title}\n\n正文：\n{text[:MAX_TEXT_CHARS]}"}],
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()


async def _process_source(
    url: str,
    *,
    session,
    agent,
    base_instructions: str,
    sources_state: list,
) -> None:
    """後台任務：fetch → summarize → inject → 恢復聽 → 主動開口。"""
    # 1. 抓取（確定性，走 thread）
    fetched = await asyncio.to_thread(_fetch_source_sync, url)
    if not fetched.get("ok"):
        reason = fetched.get("error", "讀不到")
        logger.info(f"[source] fetch failed: {reason}")
        try:
            session.input.set_audio_enabled(True)
            session.generate_reply(instructions=(
                f"你剛想打開對方分享的連結但打不開（{reason}）。"
                "用一句話自然、不尷尬地說你看不了，請對方換個方式或描述一下。"
            ))
        except Exception as e:
            logger.warning(f"[source] resume-on-fail failed: {e}")
        return

    title = (fetched.get("title") or url).strip()
    text = fetched.get("text") or ""

    # 2. 摘要（LLM 判斷題）
    try:
        digest = await _summarize(title, text)
    except Exception as e:
        logger.error(f"[source] summarize failed: {e}")
        digest = text[:1500]  # 退而求其次：直接給開頭

    # 3. 注入角色 instructions（累積所有本通已讀資料源）
    sources_state.append({"url": url, "title": title, "digest": digest})
    block = "\n\n【對話中對方分享、你剛讀過的資料】\n" + "\n\n".join(
        f"來源：{s['title']}（{s['url']}）\n{s['digest']}" for s in sources_state
    )
    try:
        await agent.update_instructions(base_instructions + block)
    except Exception as e:
        logger.error(f"[source] update_instructions failed: {e}")

    # 4. 恢復聽 + 主動開口說讀到什麼
    try:
        session.input.set_audio_enabled(True)
        session.generate_reply(instructions=(
            f"你剛讀完對方分享的『{title}』，資料已經在你腦裡了。"
            "用你這個角色自然的方式開口，說你看到了什麼、你的即時反應或想法，"
            "不要逐條報告、不要念稿，然後把話交回給對方。"
        ))
    except Exception as e:
        logger.warning(f"[source] resume failed: {e}")

    logger.info(f"[source] done title={title!r} digest_chars={len(digest)} total_sources={len(sources_state)}")


async def handle_share_source(
    url: str,
    *,
    session,
    agent,
    base_instructions: str,
    sources_state: list,
) -> str:
    """RPC 'share_source' 主入口。立即暫停→背景處理→主動接話（不 block RPC timeout）。"""
    logger.info(f"[source] share_source queued url={url!r}")

    # 暫停：讓角色停下來靜默讀取
    try:
        session.interrupt()
    except Exception as e:
        logger.warning(f"[source] interrupt failed: {e}")
    try:
        session.input.set_audio_enabled(False)
    except Exception as e:
        logger.warning(f"[source] disable input failed: {e}")

    # 後台跑，立即回傳給前端（不 block RPC timeout）
    asyncio.create_task(_process_source(
        url, session=session, agent=agent,
        base_instructions=base_instructions, sources_state=sources_state,
    ))
    return json.dumps({"ok": True, "queued": True})
