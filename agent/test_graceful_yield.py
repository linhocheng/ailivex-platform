"""
BoundaryAwareAudioOutput 單元測試（合成 PCM，離線可跑）
跑法：python3 agent/test_graceful_yield.py
場景全對應 v18 讓位行為規格：直通節流／邊界讓位／誤觸取消／真打斷收句／冷清直通。
"""
import asyncio
import sys
import os
import math
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities
from agent.graceful_yield import (
    BoundaryAwareAudioOutput, frame_rms, apply_gain, LEAD_S, MAX_YIELD_S,
)

SR = 16000
FRAME_MS = 20
SPF = SR * FRAME_MS // 1000  # samples per frame


def speech_frame(amp=8000):
    t = np.arange(SPF)
    data = (amp * np.sin(2 * np.pi * 220 * t / SR)).astype(np.int16)
    return rtc.AudioFrame(data=data.tobytes(), sample_rate=SR,
                          num_channels=1, samples_per_channel=SPF)


def silence_frame():
    return rtc.AudioFrame(data=np.zeros(SPF, dtype=np.int16).tobytes(),
                          sample_rate=SR, num_channels=1, samples_per_channel=SPF)


class FakeSink(AudioOutput):
    """記錄一切呼叫的底層輸出替身。"""
    def __init__(self):
        super().__init__(label="FakeSink",
                         capabilities=AudioOutputCapabilities(pause=True),
                         next_in_chain=None, sample_rate=SR)
        self.frames: list[rtc.AudioFrame] = []
        self.ops: list[str] = []

    async def capture_frame(self, frame):
        await super().capture_frame(frame)
        self.frames.append(frame)

    def flush(self):
        super().flush()
        self.ops.append("flush")

    def clear_buffer(self):
        self.ops.append("clear")

    def pause(self):
        self.ops.append("pause")

    def resume(self):
        self.ops.append("resume")


def build(pattern: str):
    """pattern: 'S'=20ms 語音, '.'=20ms 靜音"""
    return [speech_frame() if c == "S" else silence_frame() for c in pattern]


async def feed(out, frames):
    for f in frames:
        await out.capture_frame(f)


async def scenario_passthrough():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 30)  # 0.6s
    await feed(out, frames)
    out.flush()
    await asyncio.sleep(0.6 - LEAD_S + 0.4)
    assert len(sink.frames) == 30, f"直通掉幀: {len(sink.frames)}/30"
    assert "flush" in sink.ops and "pause" not in sink.ops and "clear" not in sink.ops
    # 節流驗證：不可能瞬間全轉發（>LEAD_S 的部分要等播放時鐘）
    await out.aclose()
    return "直通＋節流 OK"


async def scenario_yield_at_boundary():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    # 1.2s 語音 + 0.2s 靜音（子句邊界）+ 0.5s 語音
    frames = build("S" * 60 + "." * 10 + "S" * 25)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()  # 框架偵測到用戶開口
    await asyncio.sleep(1.9)
    await task
    assert "pause" in sink.ops, f"沒停在邊界: {sink.ops}"
    # 停的位置：語音段(60f)之後、靜音段內或剛過，絕不會把後段語音講完
    assert len(sink.frames) <= 72, f"讓位太晚: {len(sink.frames)} 幀"
    assert len(sink.frames) >= 55, f"讓位太早（沒講完子句）: {len(sink.frames)} 幀"
    # 讓位期音量漸降：子句尾端（讓位決定 + LEAD 之後的內容）增益明顯 < 1
    tail_rms = frame_rms(sink.frames[58])
    head_rms = frame_rms(sink.frames[5])
    assert tail_rms < head_rms * 0.8, f"沒有漸降: head={head_rms:.0f} tail={tail_rms:.0f}"
    await out.aclose()
    return f"邊界讓位 OK（{len(sink.frames)} 幀停下，音量 {head_rms:.0f}→{tail_rms:.0f}）"


async def scenario_false_interrupt_cancel():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 50)  # 1.0s 純語音（無邊界可停）
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.1)
    out.resume()  # 誤觸：0.1s 後取消
    await asyncio.sleep(1.2)
    await task
    assert "pause" not in sink.ops, f"誤觸不該真的停: {sink.ops}"
    assert len(sink.frames) == 50, f"誤觸掉幀: {len(sink.frames)}/50"
    await out.aclose()
    return "誤觸取消 OK（沒停過、零掉幀）"


async def scenario_hot_clear_finishes_clause():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    # 0.4s 語音 + 靜音邊界 + 0.6s 語音（真打斷後，後段必須被丟棄）
    frames = build("S" * 20 + "." * 10 + "S" * 30)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.05)
    out.clear_buffer()  # 真打斷 commit
    await asyncio.sleep(1.0)
    task.cancel()
    assert "clear" in sink.ops, f"沒清: {sink.ops}"
    assert out.interrupt_state["cut"] is True, "沒標記被打斷"
    assert len(sink.frames) <= 32, f"真打斷後還在講: {len(sink.frames)} 幀"
    assert len(sink.frames) >= 18, f"沒收完子句就被砍: {len(sink.frames)} 幀"
    await out.aclose()
    return f"真打斷收句 OK（{len(sink.frames)} 幀後清除）"


async def scenario_cold_clear_immediate():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 25)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.clear_buffer()  # 無 pause 前導＝冷清（3a/讀網址/收尾）→ 立即
    await asyncio.sleep(0.1)
    task.cancel()
    assert "clear" in sink.ops, f"冷清沒直通: {sink.ops}"
    n_at_clear = len(sink.frames)
    await asyncio.sleep(0.3)
    assert len(sink.frames) == n_at_clear, "冷清後還在轉發"
    await out.aclose()
    return "冷清直通 OK（立即停）"


async def scenario_max_yield_cap():
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 150)  # 3.0s 純語音，永遠沒有邊界 → 保底要生效
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    t0 = time.monotonic()
    out.pause()
    while "pause" not in sink.ops and time.monotonic() - t0 < MAX_YIELD_S + 1.0:
        await asyncio.sleep(0.05)
    waited = time.monotonic() - t0
    task.cancel()
    assert "pause" in sink.ops, "保底沒生效"
    assert waited <= MAX_YIELD_S + 0.5, f"保底超時: {waited:.2f}s"
    await out.aclose()
    return f"保底硬停 OK（{waited:.2f}s ≤ {MAX_YIELD_S}s+margin）"


async def main():
    results = []
    for fn in (scenario_passthrough, scenario_yield_at_boundary,
               scenario_false_interrupt_cancel, scenario_hot_clear_finishes_clause,
               scenario_cold_clear_immediate, scenario_max_yield_cap):
        results.append(f"✅ {await fn()}")
    print("\n".join(results))
    print(f"ALL PASS — {len(results)}/6")


if __name__ == "__main__":
    asyncio.run(main())
