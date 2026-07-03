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
        """heartbeat 主迴圈。到點 → flush + on_timeout 後結束。"""
        if not self.user_id:
            return
        while True:
            if self.remaining is not None:
                left = self.remaining - (time.time() - self._start)
                if left <= 0:
                    await self.flush()
                    logger.info(f"[quota] voice seconds exhausted user={self.user_id}")
                    try:
                        await on_timeout()
                    except Exception as e:
                        logger.error(f"[quota] on_timeout failed: {e}")
                    return
                tick = min(self.HEARTBEAT, left)
            else:
                tick = self.HEARTBEAT
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
