"""
打斷音量閘 — VolumeGate + GatedPauseOutput（v18 重設計，2026-07-10）

掛法（session.start 之後，鏈到 Room 輸出前面）：
    session.output.audio = GatedPauseOutput(next_in_chain=session.output.audio,
                                            raised_check=volume_gate.is_raised)
    （VolumeGate 由 stt_node 帶內 tap 餵 frame，見 realtime_agent_v18.stt_node）

治什麼：v17 對「任何聲音」都先暫停角色語音（框架 pause 路徑）——咳嗽、應和、
背景音都讓她卡 1.2 秒死空氣才由誤觸恢復接回。體感：她一直被小雜音打斷、講話結巴。

怎麼治（與框架合作，不對抗——上一版 v18 讓位層的死因是纏鬥框架三條 commit 路徑）：
  - pause()（框架聽到用戶聲音）→ 問音量閘：
      音量提高（≥基線×1.45）＝真搶話企圖 → 照常暫停（她立刻安靜，讓你說）
      音量沒提高＝應和/雜音 → 吞掉 pause（她照講，零死空氣）
  - resume()（誤觸恢復）→ 只在真的暫停過才轉發，否則 no-op。
  - clear_buffer()（真打斷 commit：轉寫成句、回合成立）→ 一律直通立即清。
    正常音量的真插話（「你等一下我想問」）靠這條停她——跟 v17 現行行為完全一致。
  - 零佇列、零計時器、零邊界偵測：音框直通轉發。上一版的懸置 clear／暫停孤兒／
    resume 翻案三類雷，因為沒有延遲執行，物理上不存在。

退化行為（fail-safe 全部往「v17 現狀」倒）：
  - 音量閘無基線（開頭 1.5s 內/tap 沒接到）→ is_raised()=True → 每個 pause 都轉發＝v17
  - raised_check 拋例外 → 視同提高 → 轉發 pause ＝ v17
  - AGC 壓平音量差 → 閘永不觸發提高 → pause 全吞；但 commit 直通，真話仍停她。
    最壞情況＝「提聲搶話不能讓她提前安靜」，不會聾、不會掛。

框架契約（livekit-agents==1.5.1 源碼核對）：
  - AudioOutput ABC 原生 next_in_chain 鏈式 + playback 事件自動傳播（io.py:158）
  - pause 路徑要求 can_pause（agent_activity.py:1427）→ capabilities 聲明 pause=True
  - 底層在 pause 狀態下 clear 行為未定義 → 先 resume 再 clear（上一版實測教訓）
"""
import logging

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities

logger = logging.getLogger("ailivex-interrupt-gate")


def frame_rms(frame: rtc.AudioFrame) -> float:
    """int16 PCM 的 RMS（確定性，numpy）。"""
    data = np.frombuffer(frame.data, dtype=np.int16)
    if data.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data.astype(np.float64)))))


class VolumeGate:
    """用戶音量閘（確定性）。由 stt_node override 餵 frame（v11 聲紋同款帶內 tap）。
    整通累積說話音量基線（滾動中位數），is_raised()＝最近 0.4s 平均 ≥ 基線 × RAISE_FACTOR。
    基線不足（開頭 / tap 沒接到）→ fail-open 回 True＝退回「任何聲音都算打斷」的既有行為。
    ⚠️ 瀏覽器 AGC（autoGainControl）可能壓平音量差——實測若閘永不觸發，調 RAISE_FACTOR
    或前端 getUserMedia 關 AGC。2026-07-10 真通話實證：AGC 沒吃光音量差，閘有效。"""
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


class GatedPauseOutput(AudioOutput):
    """薄閘：只攔 pause，其他全直通。狀態只有一個 bool（_paused_downstream）。"""

    def __init__(self, next_in_chain: AudioOutput, raised_check=None) -> None:
        self._raised_check = raised_check   # callable → bool；None＝永遠視為提高（=v17 行為）
        super().__init__(
            label="GatedPauseOutput",
            capabilities=AudioOutputCapabilities(pause=True),
            next_in_chain=next_in_chain,
            sample_rate=next_in_chain.sample_rate,
        )
        self._paused_downstream = False   # 我們真的把 pause 轉發下去了嗎

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await super().capture_frame(frame)
        if self.next_in_chain:
            await self.next_in_chain.capture_frame(frame)

    def flush(self) -> None:
        super().flush()
        if self.next_in_chain:
            self.next_in_chain.flush()

    def pause(self) -> None:
        raised = True
        if self._raised_check is not None:
            try:
                raised = bool(self._raised_check())
            except Exception as e:
                logger.warning(f"音量閘判斷失敗，視同提高（=v17 行為）: {e}")
        if raised:
            self._paused_downstream = True
            if self.next_in_chain:
                self.next_in_chain.pause()
            logger.info("音量閘：提聲搶話 → 暫停角色語音")
        else:
            logger.info("音量閘：音量未提高 → 吞掉 pause，她照講（真話會經 commit 停她）")

    def resume(self) -> None:
        if self._paused_downstream:
            self._paused_downstream = False
            if self.next_in_chain:
                self.next_in_chain.resume()
            logger.info("音量閘：誤觸恢復 → 續播")
        # 沒轉發過 pause ＝ 沒東西要恢復（她根本沒停過）

    def clear_buffer(self) -> None:
        # 真打斷 commit 一律直通（v17 同款體感）。底層 pause 下 clear 未定義 → 先 resume。
        if self._paused_downstream and self.next_in_chain:
            self._paused_downstream = False
            self.next_in_chain.resume()
        if self.next_in_chain:
            self.next_in_chain.clear_buffer()
