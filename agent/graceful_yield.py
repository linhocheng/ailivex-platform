"""
優雅讓位音訊層 — BoundaryAwareAudioOutput（v18）

掛法（session.start 之後，鏈到 Room 輸出前面）：
    session.output.audio = BoundaryAwareAudioOutput(next_in_chain=session.output.audio)

治什麼：LiveKit 的打斷是「瞬間靜音」——pause()/clear_buffer() 一喊，話切在半個字上。
真人被搶話不是這樣：講完當前子句、邊收尾邊放低聲音、才讓位。

怎麼治（全確定性，不丟 LLM）：
  - 節流轉發：內部佇列 + 轉發 task，領先真實播放最多 LEAD_S 秒。
    這是「延後停」可行的前提——底層 Room 輸出手上永遠只有一小截音訊。
  - 子句邊界＝音訊能量谷：對流過的 PCM 算 RMS，讓位期間遇到 ≥MIN_DIP_S 的
    靜音谷（TTS 在標點處天然停頓）就是讓位點；MAX_YIELD_S 保底硬停。
  - pause()（框架偵測到用戶開口）→ 不立停，進 YIELDING：繼續轉發、音量漸降，
    到邊界才真的 pause 底層。
  - resume()（誤觸：咳嗽/應和沒下文）→ YIELDING 中收到＝取消讓位、音量漸回，
    她根本沒停過；已停在邊界則無縫續播。
  - clear_buffer()（真打斷 commit）→ 讓位中＝撐到邊界才清（框架契約：clear 後
    await wait_for_playout()，逐字稿截斷會正確含多播的字）；非讓位狀態（3a/
    讀網址/收尾的冷清）＝立即清，不干涉。
  - interrupt_state["cut"] 供 agent 端 chat_ctx 標記「這句被打斷沒說完」。

框架契約依據（livekit-agents==1.5.1 源碼核對）：
  - AudioOutput ABC 原生 next_in_chain 鏈式 + playback 事件自動傳播
  - clear_buffer() 後框架必 await wait_for_playout() → 延後清不會雙聲
  - 佇列裡最多一個開放 segment（框架逐句 await playout 才排下一句）
  - 防 hang：被整段吞掉（0 frame 轉發）的 segment 必須自行補發
    on_playback_finished，否則 wait_for_playout 永久卡死
"""
import asyncio
import logging
import time

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities

logger = logging.getLogger("ailivex-graceful-yield")

LEAD_S = 0.35          # 轉發領先播放的上限（越小讓位越準，太小怕斷流）
MIN_DIP_S = 0.12       # 連續靜音多久算子句邊界
MAX_YIELD_S = 1.8      # 讓位保底：找不到邊界最多多講這麼久
DUCK_GAIN = 0.55       # 讓位期音量降到幾成（邊收尾邊放低聲音）
DUCK_RAMP_S = 0.5      # 音量降到位要幾秒
SILENCE_FLOOR = 250.0  # int16 RMS 絕對靜音門檻（≈ -42 dBFS）
SILENCE_REL = 0.08     # 或相對門檻：低於滾動峰值的 8%
PEAK_DECAY = 0.995     # 滾動峰值每 frame 衰減（適應音量變化）

_NORMAL, _YIELDING, _PAUSED, _CLEAR_AT_BOUNDARY = "normal", "yielding", "paused", "clear_at_boundary"
_FLUSH = object()


def frame_rms(frame: rtc.AudioFrame) -> float:
    """int16 PCM 的 RMS（確定性，numpy）。"""
    data = np.frombuffer(frame.data, dtype=np.int16)
    if data.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data.astype(np.float64)))))


def apply_gain(frame: rtc.AudioFrame, gain: float) -> rtc.AudioFrame:
    """回傳套了增益的新 frame（不動原 frame）。gain≈1 直接原樣回。"""
    if gain >= 0.999:
        return frame
    data = np.frombuffer(frame.data, dtype=np.int16).astype(np.float64) * gain
    out = np.clip(data, -32768, 32767).astype(np.int16)
    return rtc.AudioFrame(
        data=out.tobytes(), sample_rate=frame.sample_rate,
        num_channels=frame.num_channels, samples_per_channel=frame.samples_per_channel,
    )


class BoundaryAwareAudioOutput(AudioOutput):
    def __init__(self, next_in_chain: AudioOutput) -> None:
        super().__init__(
            label="BoundaryAwareAudioOutput",
            capabilities=AudioOutputCapabilities(pause=True),
            next_in_chain=next_in_chain,
            sample_rate=next_in_chain.sample_rate,
        )
        self._q: asyncio.Queue = asyncio.Queue()
        self._state = _NORMAL
        self._gain = 1.0
        self._yield_started_at = 0.0     # 讓位起點（播放時間軸，秒）
        self._duck_from_s = 0.0          # 漸降起點（內容時間軸，秒）
        self._silence_run = 0.0          # 讓位期間累計的連續靜音秒數
        self._rolling_peak = SILENCE_FLOOR / SILENCE_REL  # RMS 滾動峰值
        # 播放時鐘：轉發秒數 vs 牆鐘（pause 期間凍結）
        self._forwarded_s = 0.0
        self._clock_base = 0.0           # 累計的非暫停牆鐘
        self._clock_mark: float | None = None  # 目前這段非暫停的起點
        self._seg_forwarded = 0          # 當前 segment 已轉發 frame 數（防 hang 補償用）
        self._resume_ev = asyncio.Event()
        self._resume_ev.set()
        self._forwarder_task: asyncio.Task | None = None
        self._closed = False
        # 給 agent 端讀的打斷狀態（chat_ctx 標記用；one-shot，讀完自己清）
        self.interrupt_state: dict = {"cut": False}

    # ── 播放時鐘 ──────────────────────────────────────────────
    def _clock_start(self) -> None:
        if self._clock_mark is None:
            self._clock_mark = time.monotonic()

    def _clock_stop(self) -> None:
        if self._clock_mark is not None:
            self._clock_base += time.monotonic() - self._clock_mark
            self._clock_mark = None

    def _played_s(self) -> float:
        el = self._clock_base + (time.monotonic() - self._clock_mark if self._clock_mark else 0.0)
        return min(el, self._forwarded_s)

    # ── AudioOutput 介面 ──────────────────────────────────────
    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await super().capture_frame(frame)
        if self._forwarder_task is None or self._forwarder_task.done():
            self._forwarder_task = asyncio.create_task(self._forwarder())
        self._q.put_nowait(frame)

    def flush(self) -> None:
        super().flush()
        self._q.put_nowait(_FLUSH)

    def pause(self) -> None:
        # 框架偵測到用戶開口。不立停——進讓位；已在讓位/暫停就不重進。
        if self._state == _NORMAL:
            self._state = _YIELDING
            self._yield_started_at = self._played_s()
            # 漸降以「內容時間軸」計：讓位瞬間已轉發的 LEAD 秒是覆水難收的全音量，
            # 從下一個要轉發的內容位置開始降（wall-clock 計會永遠追不上轉發頭）
            self._duck_from_s = self._forwarded_s
            self._silence_run = 0.0
            logger.info("讓位開始：撐到子句邊界（上限 %.1fs）", MAX_YIELD_S)

    def resume(self) -> None:
        if self._state == _YIELDING:
            self._state = _NORMAL
            logger.info("誤觸取消：邊界未到，話沒停過")
        elif self._state == _PAUSED:
            self._state = _NORMAL
            if self.next_in_chain:
                self.next_in_chain.resume()
            logger.info("誤觸恢復：從子句邊界續播")
        self._gain_target_normal()
        self._resume_ev.set()

    def clear_buffer(self) -> None:
        if self._state == _YIELDING:
            # 真打斷 commit，但子句還沒收完 → 撐到邊界才清
            self._state = _CLEAR_AT_BOUNDARY
            self.interrupt_state["cut"] = True
            logger.info("真打斷：收完當前子句即讓位")
            return
        if self._state == _PAUSED:
            self.interrupt_state["cut"] = True
        self._hard_clear()

    # ── 內部 ─────────────────────────────────────────────────
    def _gain_target_normal(self) -> None:
        self._gain = 1.0  # 恢復瞬間拉回（升音量突變無感，降才需要 ramp）

    def _hard_clear(self) -> None:
        # 丟掉內部佇列＋清底層。整段被吞（0 frame 轉發）要自行補 playback_finished 防 hang。
        swallowed_open_segment = self._seg_forwarded == 0 and not self._q.empty()
        while not self._q.empty():
            try:
                self._q.get_nowait()
            except asyncio.QueueEmpty:
                break
        if self._state == _PAUSED and self.next_in_chain:
            self.next_in_chain.resume()  # 底層在 pause 狀態下 clear 行為未定義，先 resume 再清
        self._state = _NORMAL
        self._gain_target_normal()
        self._resume_ev.set()
        if self.next_in_chain:
            if self._seg_forwarded > 0:
                self.next_in_chain.clear_buffer()   # 底層會 emit playback_finished(interrupted)
            elif swallowed_open_segment:
                self.on_playback_finished(playback_position=0.0, interrupted=True)
        self._seg_forwarded = 0

    async def _forwarder(self) -> None:
        try:
            while not self._closed:
                item = await self._q.get()
                if item is _FLUSH:
                    if self.next_in_chain:
                        self.next_in_chain.flush()
                    self._seg_forwarded = 0
                    continue
                frame: rtc.AudioFrame = item
                dur = frame.samples_per_channel / frame.sample_rate

                # 節流：領先播放不超過 LEAD_S（讓「延後停」有實際效果）
                while (self._forwarded_s - self._played_s()) > LEAD_S:
                    await asyncio.sleep(0.04)
                    if self._closed:
                        return

                # 讓位狀態機（先判斷，再轉發）
                if self._state in (_YIELDING, _CLEAR_AT_BOUNDARY):
                    rms = frame_rms(frame)
                    self._rolling_peak = max(rms, self._rolling_peak * PEAK_DECAY,
                                             SILENCE_FLOOR / SILENCE_REL)
                    thresh = max(SILENCE_FLOOR, self._rolling_peak * SILENCE_REL)
                    self._silence_run = self._silence_run + dur if rms < thresh else 0.0
                    over_budget = (self._played_s() - self._yield_started_at) >= MAX_YIELD_S
                    at_boundary = self._silence_run >= MIN_DIP_S
                    if at_boundary or over_budget:
                        if self._state == _CLEAR_AT_BOUNDARY:
                            logger.info("子句收完 → 清除讓位（%s）",
                                        "邊界" if at_boundary else "保底")
                            self._hard_clear()
                            continue
                        # YIELDING → 停在邊界，等 resume（誤觸）或 clear（真打斷）
                        self._state = _PAUSED
                        self._clock_stop()
                        self._resume_ev.clear()
                        if self.next_in_chain:
                            self.next_in_chain.pause()
                        logger.info("讓位完成：停在子句邊界（%s）",
                                    "邊界" if at_boundary else "保底")
                        await self._resume_ev.wait()
                        if self._closed:
                            return
                        self._clock_start()
                        if self._state == _NORMAL and self._q.qsize() == 0 and self._seg_forwarded == 0:
                            continue  # 被 hard_clear 清空
                    # 讓位期音量漸降（內容時間軸）
                    if self._state in (_YIELDING, _CLEAR_AT_BOUNDARY):
                        prog = min(1.0, max(0.0, (self._forwarded_s - self._duck_from_s) / DUCK_RAMP_S))
                        self._gain = 1.0 - (1.0 - DUCK_GAIN) * prog
                else:
                    rms = frame_rms(frame)
                    self._rolling_peak = max(rms, self._rolling_peak * PEAK_DECAY,
                                             SILENCE_FLOOR / SILENCE_REL)

                if self.next_in_chain:
                    self._clock_start()
                    await self.next_in_chain.capture_frame(apply_gain(frame, self._gain))
                    self._forwarded_s += dur
                    self._seg_forwarded += 1
        except Exception:
            logger.exception("graceful-yield forwarder 掛了，退化為直通")
            # 防聾：轉發迴圈死掉時把剩餘佇列直通底層
            while not self._q.empty():
                item = self._q.get_nowait()
                if item is _FLUSH and self.next_in_chain:
                    self.next_in_chain.flush()
                elif self.next_in_chain and item is not _FLUSH:
                    await self.next_in_chain.capture_frame(item)

    async def aclose(self) -> None:
        self._closed = True
        self._resume_ev.set()
        if self._forwarder_task:
            self._forwarder_task.cancel()
