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
MIN_DIP_S = 0.24       # 連續靜音多久算句子邊界（240ms≈句號級停頓；120ms 是逗號級）
MAX_YIELD_S = 2.8      # 讓位保底：找不到邊界最多多講這麼久（句子級要給足收尾空間）
PAUSED_ORPHAN_S = 2.5  # 暫停孤兒自癒：停在邊界後這麼久沒有 resume/clear ＝ 框架走了
                       # 「對已暫停語音的默殺路徑」（不 clear 不 resume），自己收攤
DUCK_GAIN = 0.55       # 讓位期音量降到幾成（邊收尾邊放低聲音）
DUCK_RAMP_S = 0.5      # 音量降到位要幾秒
SILENCE_FLOOR = 250.0  # int16 RMS 絕對靜音門檻（≈ -42 dBFS）
SILENCE_REL = 0.08     # 或相對門檻：低於滾動峰值的 8%
PEAK_DECAY = 0.995     # 滾動峰值每 frame 衰減（適應音量變化）

_NORMAL, _YIELDING, _PAUSED, _CLEAR_AT_BOUNDARY = "normal", "yielding", "paused", "clear_at_boundary"
_SHADOW = "shadow"     # 影子讓位：音量未提高——她照講不受影響，但記住被 pause 過，
                       # 之後若真 commit（clear）仍走「講完整句才停」
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


class VolumeGate:
    """用戶音量閘（確定性）。由 stt_node override 餵 frame（v11 聲紋同款帶內 tap）。
    整通累積說話音量基線（滾動中位數），is_raised()＝最近 0.4s 平均 ≥ 基線 × RAISE_FACTOR。
    基線不足（開頭 / tap 沒接到）→ fail-open 回 True＝退回「任何聲音都算打斷」的既有行為。
    ⚠️ 瀏覽器 AGC（autoGainControl）可能壓平音量差——實測若閘永不觸發，調 RAISE_FACTOR
    或前端 getUserMedia 關 AGC。"""
    RAISE_FACTOR = 1.45      # ≈ +3.2dB
    NOISE_GATE = 220.0       # int16 RMS 低於此視為非語音，不進基線
    RECENT_WINDOW_S = 0.4
    MIN_BASELINE_S = 1.5     # 語音基線至少累積這麼多秒才啟用判斷

    def __init__(self) -> None:
        from collections import deque
        self._baseline = deque(maxlen=600)   # 語音 frame 的 RMS（~長期）
        self._recent = deque()               # (dur, rms) 最近窗
        self._recent_dur = 0.0
        self._baseline_dur = 0.0

    def push(self, frame) -> None:
        try:
            rms = frame_rms(frame)
        except Exception:
            return
        dur = frame.samples_per_channel / frame.sample_rate
        if rms >= self.NOISE_GATE:
            self._baseline.append(rms)
            self._baseline_dur += dur
        self._recent.append((dur, rms))
        self._recent_dur += dur
        while self._recent_dur > self.RECENT_WINDOW_S and len(self._recent) > 1:
            d, _ = self._recent.popleft()
            self._recent_dur -= d

    def is_raised(self) -> bool:
        if self._baseline_dur < self.MIN_BASELINE_S or not self._baseline:
            return True   # fail-open：沒有基線就退回既有行為
        speech = [r for _, r in self._recent if r >= self.NOISE_GATE]
        if not speech:
            return False  # 最近窗根本沒語音能量（雜訊誤觸）→ 不算提高
        recent_mean = sum(speech) / len(speech)
        srt = sorted(self._baseline)
        median = srt[len(srt) // 2]
        return recent_mean >= median * self.RAISE_FACTOR


class BoundaryAwareAudioOutput(AudioOutput):
    def __init__(self, next_in_chain: AudioOutput, raised_check=None) -> None:
        self._raised_check = raised_check   # callable → bool；None＝永遠視為音量提高（既有行為）
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
        self._failsafe_handle: asyncio.TimerHandle | None = None
        self._yield_token = 0
        self._seq_in = 0            # 進佇列序號（clear 截斷用）
        self._clear_at = 0.0        # 進入 CLEAR_AT_BOUNDARY 的時刻
        self._clear_cut_seq = None  # 清除只殺 ≤ 此序號的舊句音框
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
        self._seq_in += 1
        self._q.put_nowait((self._seq_in, frame))

    def flush(self) -> None:
        super().flush()
        self._seq_in += 1
        self._q.put_nowait((self._seq_in, _FLUSH))

    def pause(self) -> None:
        # 框架偵測到用戶開口。不立停——進讓位；已在讓位/暫停就不重進。
        if self._state == _NORMAL:
            # 音量閘：沒提高＝影子模式（她照講；真 commit 時仍講完整句才停）
            if self._raised_check is not None:
                try:
                    if not self._raised_check():
                        self._state = _SHADOW
                        logger.info("影子讓位：音量未提高，照講（commit 仍會收完整句）")
                        return
                except Exception as e:
                    logger.warning(f"音量閘判斷失敗，回讓位路徑: {e}")
            self._state = _YIELDING
            self._yield_started_at = self._played_s()
            # 漸降以「內容時間軸」計：讓位瞬間已轉發的 LEAD 秒是覆水難收的全音量，
            # 從下一個要轉發的內容位置開始降（wall-clock 計會永遠追不上轉發頭）
            self._duck_from_s = self._forwarded_s
            self._silence_run = 0.0
            self._arm_failsafe()   # 佇列空（音框全轉發/生成已結束）時邊界掃描不會跑，保底計時器兜底
            logger.info("讓位開始：撐到子句邊界（上限 %.1fs）", MAX_YIELD_S)

    def resume(self) -> None:
        if self._state == _SHADOW:
            self._state = _NORMAL
            return
        if self._state == _YIELDING:
            self._state = _NORMAL
            logger.info("誤觸取消：邊界未到，話沒停過")
        elif self._state == _PAUSED:
            self._state = _NORMAL
            self._yield_token += 1   # 解除孤兒自癒
            if self.next_in_chain:
                self.next_in_chain.resume()
            logger.info("誤觸恢復：從子句邊界續播")
        elif self._state == _CLEAR_AT_BOUNDARY:
            # commit 之後的 resume 一律視為框架狀態重置，絕不翻案取消清除。
            # 理由：clear 到達＝框架已把回合定案（逐字稿已截斷、開始生成新回覆），
            # 事後續播舊句必然「消化兩次」。時間護欄不可靠——狀態重置 resume 會先等
            # 生成收尾才發，實測 74µs 到 459ms 都出現過（2026-07-10 兩通實測）。
            # 真正的誤觸翻案只存在於 commit 之前（上面 _YIELDING/_PAUSED 兩條路徑）。
            logger.info("resume 於清除排程中（+%.0fms）＝框架狀態重置，清除照排程",
                        (time.monotonic() - self._clear_at) * 1000)
        self._gain_target_normal()
        self._resume_ev.set()

    def clear_buffer(self) -> None:
        if self._state in (_YIELDING, _SHADOW):
            # 真打斷 commit，但句子還沒收完 → 撐到邊界才清。
            # 影子模式進來＝正常音量的完整回合：一樣講完整句才讓（不瞬砍）。
            # 只清「clear 當下已在佇列的舊句音框」——commit 後框架就開始生成新回覆，
            # 新句音框會在 drain 期間到達，不設界線會被邊界清除誤殺（回覆被吃掉）。
            if self._state == _SHADOW:   # 影子直接 commit：現在才起算讓位/漸降
                self._yield_started_at = self._played_s()
                self._duck_from_s = self._forwarded_s
                self._silence_run = 0.0
            self._state = _CLEAR_AT_BOUNDARY
            self._clear_at = time.monotonic()
            self._clear_cut_seq = self._seq_in
            self.interrupt_state["cut"] = True
            self._arm_failsafe()
            logger.info("真打斷：收完當前子句即讓位")
            return
        if self._state == _PAUSED:
            self.interrupt_state["cut"] = True
        self._hard_clear()

    # ── 內部 ─────────────────────────────────────────────────
    def _arm_orphan_failsafe(self) -> None:
        """暫停孤兒自癒。框架對「已暫停的語音」有一條默殺 commit 路徑
        （_paused_speech.interrupt()，agent_activity:3126）——不呼叫 clear、
        resume 也要等它 5s arbitrary-cancel 之後才來。我們停在邊界乾等＝
        新回覆音框全堵死（2026-07-10 實測 16 秒黑洞）。停下 PAUSED_ORPHAN_S
        沒等到任何指令 → 自己收攤：釋放底層＋清殘尾（觸發 playback_finished
        把框架從等待中救出）＋丟舊句音框，回 NORMAL 讓新句流動。"""
        self._yield_token += 1
        tok = self._yield_token
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._failsafe_handle:
            self._failsafe_handle.cancel()
        self._failsafe_handle = loop.call_later(PAUSED_ORPHAN_S, self._orphan_fire, tok)

    def _orphan_fire(self, tok: int) -> None:
        if tok != self._yield_token or self._state != _PAUSED:
            return
        logger.info("暫停孤兒自癒：%.1fs 無 resume/clear（框架默殺路徑）→ 收攤放行新句", PAUSED_ORPHAN_S)
        # 丟舊句：清到第一個 FLUSH（含）為止；沒有 FLUSH 就全部是舊句
        survivors, seen_flush = [], False
        while not self._q.empty():
            try:
                sq, it = self._q.get_nowait()
            except asyncio.QueueEmpty:
                break
            if seen_flush:
                survivors.append((sq, it))
            elif it is _FLUSH:
                seen_flush = True
        for x in survivors:
            self._q.put_nowait(x)
        self.interrupt_state["cut"] = True
        self._state = _NORMAL
        self._gain_target_normal()
        if self.next_in_chain:
            self.next_in_chain.resume()        # 先解除暫停
            if self._seg_forwarded > 0:
                self.next_in_chain.clear_buffer()  # 再清殘尾 → playback_finished 救出框架
        self._seg_forwarded = 0
        self._resume_ev.set()                  # 解鎖 forwarder

    def _arm_failsafe(self) -> None:
        """讓位/清除的牆鐘保底。狀態機由音框流驅動——佇列空掉（全部已轉發或
        生成結束）時邊界掃描永遠不會跑，沒有這個計時器 deferred clear 會懸置、
        wait_for_playout 跟著卡住（2026-07-10 實測通話的『反應變慢』一環）。"""
        self._yield_token += 1
        tok = self._yield_token
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._failsafe_handle:
            self._failsafe_handle.cancel()
        self._failsafe_handle = loop.call_later(MAX_YIELD_S + 0.2, self._failsafe_fire, tok)

    def _failsafe_fire(self, tok: int) -> None:
        if tok != self._yield_token:
            return
        if self._state == _YIELDING:
            self._state = _PAUSED
            self._clock_stop()
            self._resume_ev.clear()
            if self.next_in_chain:
                self.next_in_chain.pause()
            self._arm_orphan_failsafe()
            logger.info("讓位保底（無音框可掃）→ 直接停")
        elif self._state == _CLEAR_AT_BOUNDARY:
            logger.info("清除保底（無音框可掃）→ 直接清")
            self._hard_clear(self._clear_cut_seq)

    def _gain_target_normal(self) -> None:
        self._gain = 1.0  # 恢復瞬間拉回（升音量突變無感，降才需要 ramp）

    def _hard_clear(self, cut_seq: int | None = None) -> None:
        # 丟掉內部佇列（cut_seq 給定時只殺 ≤cut_seq 的舊句，clear 之後才到的新回覆音框倖存）
        # ＋清底層。整段被吞（0 frame 轉發）要自行補 playback_finished 防 hang。
        swallowed_open_segment = self._seg_forwarded == 0 and not self._q.empty()
        survivors = []
        while not self._q.empty():
            try:
                sq, it = self._q.get_nowait()
            except asyncio.QueueEmpty:
                break
            if cut_seq is not None and sq > cut_seq:
                survivors.append((sq, it))
        if self._state == _PAUSED and self.next_in_chain:
            self.next_in_chain.resume()  # 底層在 pause 狀態下 clear 行為未定義，先 resume 再清
        self._yield_token += 1           # 解除任何 pending 保底/孤兒計時
        self._state = _NORMAL
        self._gain_target_normal()
        self._resume_ev.set()
        if self.next_in_chain:
            if self._seg_forwarded > 0:
                self.next_in_chain.clear_buffer()   # 底層會 emit playback_finished(interrupted)
            elif swallowed_open_segment:
                self.on_playback_finished(playback_position=0.0, interrupted=True)
        self._seg_forwarded = 0
        self._clear_cut_seq = None
        for x in survivors:
            self._q.put_nowait(x)

    async def _forwarder(self) -> None:
        try:
            while not self._closed:
                _sq, item = await self._q.get()
                if item is _FLUSH:
                    if self.next_in_chain:
                        self.next_in_chain.flush()
                    self._seg_forwarded = 0
                    continue
                frame: rtc.AudioFrame = item
                dur = frame.samples_per_channel / frame.sample_rate

                # 新 segment ＝ 播放時鐘歸零。時鐘若跨 segment 累積，句與句之間的
                # 閒置牆鐘會讓 played_s 永遠貼著 forwarded_s（min 被 forwarded 封頂）
                # → 節流失效、讓位預算以合成速度燒完（實測 0.6s 就打保底）。
                if self._seg_forwarded == 0:
                    self._clock_base = 0.0
                    self._clock_mark = None
                    self._forwarded_s = 0.0
                    self._silence_run = 0.0
                    if self._state in (_YIELDING, _CLEAR_AT_BOUNDARY):
                        self._yield_started_at = 0.0
                        self._duck_from_s = 0.0

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
                            self._hard_clear(self._clear_cut_seq)
                            continue
                        # YIELDING → 停在邊界，等 resume（誤觸）或 clear（真打斷）
                        self._state = _PAUSED
                        self._clock_stop()
                        self._resume_ev.clear()
                        if self.next_in_chain:
                            self.next_in_chain.pause()
                        self._arm_orphan_failsafe()
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
                _sq, item = self._q.get_nowait()
                if item is _FLUSH and self.next_in_chain:
                    self.next_in_chain.flush()
                elif self.next_in_chain and item is not _FLUSH:
                    await self.next_in_chain.capture_frame(item)

    async def aclose(self) -> None:
        self._closed = True
        self._resume_ev.set()
        if self._forwarder_task:
            self._forwarder_task.cancel()
