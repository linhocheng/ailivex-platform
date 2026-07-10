"""
GatedPauseOutput / VolumeGate 單元測試（合成 PCM，離線可跑）
跑法：python3 agent/test_interrupt_gate.py
薄閘只有四條行為路徑，全部覆蓋：吞 pause／轉發 pause／commit 直通／resume 配對。
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities
from agent.interrupt_gate import GatedPauseOutput, VolumeGate

SR = 16000
SPF = SR * 20 // 1000  # 20ms


def speech_frame(amp=8000):
    t = np.arange(SPF)
    data = (amp * np.sin(2 * np.pi * 220 * t / SR)).astype(np.int16)
    return rtc.AudioFrame(data=data.tobytes(), sample_rate=SR,
                          num_channels=1, samples_per_channel=SPF)


def silence_frame():
    return rtc.AudioFrame(data=np.zeros(SPF, dtype=np.int16).tobytes(),
                          sample_rate=SR, num_channels=1, samples_per_channel=SPF)


class FakeSink(AudioOutput):
    def __init__(self):
        super().__init__(label="FakeSink",
                         capabilities=AudioOutputCapabilities(pause=True),
                         next_in_chain=None, sample_rate=SR)
        self.frames = []
        self.ops = []

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


async def t_passthrough():
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink)
    for _ in range(10):
        await out.capture_frame(speech_frame())
    out.flush()
    assert len(sink.frames) == 10 and "flush" in sink.ops
    return "直通轉發 OK（零佇列零延遲）"


async def t_swallow_pause():
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=lambda: False)
    await out.capture_frame(speech_frame())
    out.pause()      # 音量沒提高 → 吞掉
    out.resume()     # 誤觸恢復 → 沒暫停過，no-op
    assert "pause" not in sink.ops, f"該吞掉的 pause 漏下去了: {sink.ops}"
    assert "resume" not in sink.ops, f"沒暫停過不該 resume: {sink.ops}"
    return "吞 pause OK（她照講、resume 不亂發）"


async def t_forward_pause_resume():
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=lambda: True)
    await out.capture_frame(speech_frame())
    out.pause()      # 提聲 → 轉發
    out.resume()     # 誤觸恢復 → 配對轉發
    assert sink.ops.count("pause") == 1 and sink.ops.count("resume") == 1, f"{sink.ops}"
    return "提聲暫停＋誤觸恢復 OK（配對轉發）"


async def t_commit_passthrough_shadow():
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=lambda: False)
    await out.capture_frame(speech_frame())
    out.pause()          # 吞掉（影子）
    out.clear_buffer()   # 真打斷 commit → 直通立即清
    assert "clear" in sink.ops and "pause" not in sink.ops, f"{sink.ops}"
    assert "resume" not in sink.ops, f"沒暫停過 clear 前不該 resume: {sink.ops}"
    return "影子後 commit 直通 OK（立即清、不摻和）"


async def t_commit_while_paused():
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=lambda: True)
    await out.capture_frame(speech_frame())
    out.pause()          # 轉發暫停
    out.clear_buffer()   # commit：pause 下 clear 未定義 → 先 resume 再 clear
    i_r, i_c = sink.ops.index("resume"), sink.ops.index("clear")
    assert i_r < i_c, f"必須先 resume 再 clear: {sink.ops}"
    out.resume()         # 框架後續 resume → 已配對過，no-op
    assert sink.ops.count("resume") == 1, f"resume 重複轉發: {sink.ops}"
    return "暫停中 commit OK（先 resume 再 clear、後續 resume 不重發）"


async def t_pause_idempotent():
    """框架同一段發話連打 pause 十次 → 底層只收到一次（冪等），resume 後可再暫停。"""
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=lambda: True)
    await out.capture_frame(speech_frame())
    for _ in range(10):
        out.pause()
    assert sink.ops.count("pause") == 1, f"pause 該冪等: {sink.ops}"
    out.resume()
    out.pause()   # 新一段發話 → 可以再暫停
    assert sink.ops.count("pause") == 2, f"resume 後該可再暫停: {sink.ops}"
    return "pause 冪等 OK（連打十次只轉發一次，resume 後可再暫停）"


async def t_gate_fail_open():
    def boom():
        raise RuntimeError("gate exploded")
    sink = FakeSink()
    out = GatedPauseOutput(next_in_chain=sink, raised_check=boom)
    await out.capture_frame(speech_frame())
    out.pause()
    assert "pause" in sink.ops, f"閘炸掉要 fail-open 成 v17 行為: {sink.ops}"
    return "閘例外 fail-open OK（退回 v17 行為）"


async def t_volume_gate_math():
    g = VolumeGate()
    assert g.is_raised() is True, "無基線要 fail-open"
    for _ in range(120):
        g.push(speech_frame(8000))       # 2.4s 正常語音建基線
    assert g.is_raised() is False, "同音量不該算提高"
    for _ in range(20):
        g.push(speech_frame(16000))      # 0.4s 大聲
    assert g.is_raised() is True, "音量翻倍該算提高"
    for _ in range(20):
        g.push(silence_frame())          # 最近窗換靜音
    assert g.is_raised() is False, "純雜訊不該算提高"
    return "音量閘數學 OK（fail-open/基線/提高/雜訊四態）"


async def main():
    tests = (t_passthrough, t_swallow_pause, t_forward_pause_resume,
             t_commit_passthrough_shadow, t_commit_while_paused,
             t_pause_idempotent, t_gate_fail_open, t_volume_gate_math)
    for fn in tests:
        print(f"✅ {await fn()}")
    print(f"ALL PASS — {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    asyncio.run(main())
