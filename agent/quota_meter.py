"""用量管制（語音側）— 與 TS src/lib/quota.ts 對齊的 Python 端。

共用模組（所有 agent 版本可用，additive、無人 import 前零影響）。

分工（天條）：計時、扣量、判斷全是確定性程式，LLM 不參與。
- VoiceMeter：通話計量。heartbeat 每 60 秒把實際經過秒數寫回
  users/{uid}.voiceSecondsUsed（agent crash 最多漏一分鐘）；
  額度歸零 → 呼叫 on_timeout（caller 決定怎麼斷房）。
- consume_doc_quota / refund 對齊 TS consumeDocQuota：transaction 內查+扣。
"""
import asyncio
import logging
import time

from firebase_admin import firestore

from agent.firestore_loader import _ensure_init

logger = logging.getLogger("quota-meter")


def add_voice_seconds(user_id: str, seconds: int) -> None:
    """語音計量：只加不減。同步呼叫（caller 用 asyncio.to_thread 包）。"""
    if not user_id or seconds <= 0:
        return
    _ensure_init()
    db = firestore.client()
    db.collection("users").document(user_id).update({
        "voiceSecondsUsed": firestore.Increment(int(seconds)),
    })


def get_voice_state(user_id: str):
    """讀活狀態 (limit, used)。所有並發房共用同一 voiceSecondsUsed 桶 —— meter 每
    heartbeat 回查，才能在多開時收斂到單一額度（關閉快照各算各的繞過）。
    limit=None 代表不限。同步呼叫（caller 用 asyncio.to_thread 包）。"""
    if not user_id:
        return (None, 0)
    _ensure_init()
    db = firestore.client()
    d = db.collection("users").document(user_id).get().to_dict() or {}
    raw_limit = d.get("voiceSecondsLimit")
    limit = int(raw_limit) if isinstance(raw_limit, (int, float)) else None
    used = int(d.get("voiceSecondsUsed") or 0)
    return (limit, used)


def consume_doc_quota(user_id: str) -> bool:
    """文件扣量：transaction 內查+扣原子完成。額度滿回 False（不丟例外，語音 tool 好接）。"""
    if not user_id:
        return True
    _ensure_init()
    db = firestore.client()
    ref = db.collection("users").document(user_id)
    transaction = db.transaction()

    @firestore.transactional
    def _tx(tx):
        snap = ref.get(transaction=tx)
        d = snap.to_dict() or {}
        limit = d.get("docsLimit")
        used = int(d.get("docsUsed") or 0)
        if isinstance(limit, (int, float)) and used >= limit:
            return False
        tx.update(ref, {"docsUsed": firestore.Increment(1)})
        return True

    return _tx(transaction)


def consume_media_quota(user_id: str, count: int = 1) -> bool:
    """媒體扣量（圖片/影片/音檔）：transaction 內查+扣原子完成。
    額度不足回 False（不丟例外，語音 tool 好接）。count>1 給 fan-out。"""
    if not user_id or count <= 0:
        return True
    _ensure_init()
    db = firestore.client()
    ref = db.collection("users").document(user_id)
    transaction = db.transaction()

    @firestore.transactional
    def _tx(tx):
        snap = ref.get(transaction=tx)
        d = snap.to_dict() or {}
        limit = d.get("mediaLimit")
        used = int(d.get("mediaUsed") or 0)
        if isinstance(limit, (int, float)) and used + count > limit:
            return False
        tx.update(ref, {"mediaUsed": firestore.Increment(count)})
        return True

    return _tx(transaction)


class VoiceMeter:
    """通話計量器。

    remaining_seconds=None = 不限（只計量不斷線）。
    用法：
        meter = VoiceMeter(user_id, remaining)
        task = asyncio.create_task(meter.run(on_timeout=_kick))
        # 掛斷收尾：task.cancel() 後 await meter.flush()
    """

    # 30s：agent 硬 crash 最多漏記 30 秒（方向是少算，對用戶有利）；
    # 正常掛斷/重整/斷線都走 flush 精確結算，不靠 heartbeat。
    HEARTBEAT = 30.0

    def __init__(self, user_id: str, remaining_seconds: float | None):
        self.user_id = user_id
        self.remaining = float(remaining_seconds) if remaining_seconds is not None else None
        self._start = time.time()
        self._reported = 0
        self._flushed = False

    async def _report_elapsed(self) -> None:
        elapsed = int(time.time() - self._start)
        delta = elapsed - self._reported
        if delta > 0:
            await asyncio.to_thread(add_voice_seconds, self.user_id, delta)
            self._reported = elapsed

    async def run(self, on_timeout) -> None:
        """heartbeat 主迴圈。到點 → flush + on_timeout 後結束。

        到點判斷用**兩個上限取先到**：
          (1) 本房相對 mint-time 快照的經過（DB 讀失敗也不會跑不停的兜底硬上限）
          (2) DB 活狀態的共用 used ≥ limit（關閉多開繞過：所有並發房共用同一桶，
              一旦總量到點，每間房下一 heartbeat 都會斷）
        """
        if not self.user_id:
            return
        while True:
            now = time.time()

            # 不限額：只計量不斷線（維持原行為，仍寫回 voiceSecondsUsed 供追蹤）
            if self.remaining is None:
                await asyncio.sleep(self.HEARTBEAT)
                try:
                    await self._report_elapsed()
                except Exception as e:
                    logger.warning(f"[quota] heartbeat write failed（下一輪補）: {e}")
                continue

            # (1) 本房快照上限
            local_left = self.remaining - (now - self._start)

            # (2) 共用活狀態：已寫回的 used + 本房尚未寫回的秒數 = 這一刻真實總用量
            shared_exhausted = False
            live_left = None
            try:
                limit, used = await asyncio.to_thread(get_voice_state, self.user_id)
                if limit is not None:
                    unreported = max(0, int(now - self._start) - self._reported)
                    live_left = limit - (used + unreported)
                    shared_exhausted = live_left <= 0
            except Exception as e:
                logger.warning(f"[quota] 活狀態讀取失敗，暫用本房快照上限: {e}")

            if local_left <= 0 or shared_exhausted:
                await self.flush()
                logger.info(
                    f"[quota] voice exhausted user={self.user_id} "
                    f"local_left={local_left:.0f} live_left={live_left}"
                )
                try:
                    await on_timeout()
                except Exception as e:
                    logger.error(f"[quota] on_timeout failed: {e}")
                return

            # 下一 tick：本房剩餘 / 共用剩餘 / HEARTBEAT 取最小（>=1s），不睡過頭
            candidates = [self.HEARTBEAT, local_left]
            if live_left is not None:
                candidates.append(live_left)
            tick = max(1.0, min(candidates))
            await asyncio.sleep(tick)
            try:
                await self._report_elapsed()
            except Exception as e:
                logger.warning(f"[quota] heartbeat write failed（下一輪補）: {e}")

    async def flush(self) -> None:
        """結算未回報的餘秒。idempotent。"""
        if self._flushed or not self.user_id:
            return
        self._flushed = True
        try:
            await self._report_elapsed()
        except Exception as e:
            logger.error(f"[quota] flush failed: {e}")
