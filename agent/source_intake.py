"""
即時語音「讀網址」工作臺 —— Phase 1 walking skeleton（不含 RAG 持久化）。

流程（前端 RPC 'share_source' 觸發）：
  暫停聽(set_audio_enabled False + interrupt) → 說「我看一下哦」→ 抓網址正文(Vercel /api/voice-source)
  → 摘要(Haiku) → 注入角色 instructions(update_instructions) → 恢復聽 → 角色帶讀到的內容接話。

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

ACK_LINE = "我看一下哦"


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
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _summarize(title: str, text: str) -> str:
    """把抓到的正文摘要成角色「讀到了什麼」的精煉 digest。LLM 判斷題，Haiku 夠用、bridge 優先。"""
    from anthropic import AsyncAnthropic
    bridge_url = os.environ.get("BRIDGE_URL", "").strip()
    bridge_secret = os.environ.get("BRIDGE_SECRET", "").strip()
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if bridge_url and bridge_secret:
        client = AsyncAnthropic(api_key=bridge_secret, base_url=bridge_url)
    else:
        client = AsyncAnthropic(api_key=anthropic_key)
    resp = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=400,
        system=(
            "你在幫一個語音角色快速消化一篇網頁，提煉成它『讀過後記在腦裡』的重點。"
            "用 3-6 句中文，講清楚這篇在談什麼、最關鍵的幾個點。只輸出重點本身，不要前言、不要客套。"
        ),
        messages=[{"role": "user", "content": f"標題：{title}\n\n正文：\n{text[:8000]}"}],
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()


async def handle_share_source(
    url: str,
    *,
    session,
    agent,
    base_instructions: str,
    sources_state: list,
) -> str:
    """RPC 'share_source' 的主編排。回傳 JSON 字串給前端（前端據此收掉思考動畫）。"""
    logger.info(f"[source] share_source url={url!r}")

    # 1. 暫停：掐當前發話 + 關麥克風輸入（角色「停下來讀」）
    try:
        session.interrupt()
    except Exception as e:
        logger.warning(f"[source] interrupt failed: {e}")
    try:
        session.input.set_audio_enabled(False)
    except Exception as e:
        logger.warning(f"[source] disable input failed: {e}")

    # 2. 說那句（output 不受 input 暫停影響）
    try:
        session.say(ACK_LINE)
    except Exception as e:
        logger.warning(f"[source] say ack failed: {e}")

    # 3. 抓取（確定性，走 thread）
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
        return json.dumps({"ok": False, "error": reason})

    title = (fetched.get("title") or url).strip()
    text = fetched.get("text") or ""

    # 4. 摘要（LLM 判斷題）
    try:
        digest = await _summarize(title, text)
    except Exception as e:
        logger.error(f"[source] summarize failed: {e}")
        digest = text[:600]  # 退而求其次：直接給開頭，至少角色有東西可談

    # 5. 注入角色 instructions（累積所有本通已讀資料源）
    sources_state.append({"url": url, "title": title, "digest": digest})
    block = "\n\n【對話中對方分享、你剛讀過的資料】\n" + "\n\n".join(
        f"來源：{s['title']}（{s['url']}）\n{s['digest']}" for s in sources_state
    )
    try:
        await agent.update_instructions(base_instructions + block)
    except Exception as e:
        logger.error(f"[source] update_instructions failed: {e}")

    # 6. 恢復聽 + 帶讀到的內容接話
    try:
        session.input.set_audio_enabled(True)
        session.generate_reply(instructions=(
            f"你剛讀完對方分享的『{title}』。用一兩句話自然說你看到了什麼、你的即時反應或想法，"
            "口氣平實像聊天，不要逐條報告、不要念稿，然後把話交回給對方。"
        ))
    except Exception as e:
        logger.warning(f"[source] resume failed: {e}")

    logger.info(f"[source] done title={title!r} digest_chars={len(digest)} total_sources={len(sources_state)}")
    return json.dumps({"ok": True, "title": title})
