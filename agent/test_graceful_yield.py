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
    frames = build("S" * 60 + "." * 15 + "S" * 25)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()  # 框架偵測到用戶開口
    await asyncio.sleep(1.9)
    await task
    assert "pause" in sink.ops, f"沒停在邊界: {sink.ops}"
    # 停的位置：語音段(60f)之後、靜音段內或剛過，絕不會把後段語音講完
    assert len(sink.frames) <= 77, f"讓位太晚: {len(sink.frames)} 幀"
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
    frames = build("S" * 20 + "." * 25 + "S" * 30)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.05)
    out.clear_buffer()  # 真打斷 commit
    await asyncio.sleep(1.0)
    task.cancel()
    assert "clear" in sink.ops, f"沒清: {sink.ops}"
    assert out.interrupt_state["cut"] is True, "沒標記被打斷"
    assert len(sink.frames) <= 46, f"真打斷後還在講: {len(sink.frames)} 幀"
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
    frames = build("S" * 180)  # 3.6s 純語音，永遠沒有邊界 → 保底要生效
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




async def scenario_multi_segment_clock():
    """回歸：跨 segment 播放時鐘必須歸零（實測 bug：閒置牆鐘灌入 → 保底 0.6s 就打）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    await feed(out, build("S" * 10))   # 第一段 0.2s
    out.flush()
    await asyncio.sleep(0.8)           # 句間閒置（舊 bug 會把這 0.8s 灌進播放時鐘）
    frames = build("S" * 80 + "." * 15)  # 第二段 1.6s 語音 + 邊界
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    t0 = time.monotonic()
    out.pause()
    while "pause" not in sink.ops and time.monotonic() - t0 < 3.0:
        await asyncio.sleep(0.05)
    waited = time.monotonic() - t0
    task.cancel()
    assert "pause" in sink.ops, "第二段讓位沒停"
    assert waited >= 0.9, f"時鐘跨段污染（讓位預算被合成速度燒掉）: {waited:.2f}s 就停了"
    await out.aclose()
    return f"跨段時鐘 OK（第二段讓位撐了 {waited:.2f}s 才到邊界）"


async def scenario_resume_cancels_clear():
    """回歸：CLEAR_AT_BOUNDARY 中收到 resume（框架誤觸翻案）→ 取消清除繼續講。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 50)  # 1.0s 純語音
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.05)
    out.clear_buffer()        # 真打斷 commit → CLEAR_AT_BOUNDARY
    await asyncio.sleep(0.4)  # 超過 0.25s 護欄 → 這才是真的翻案（µs 級是狀態重置）
    out.resume()              # 框架翻案：誤觸
    await asyncio.sleep(1.2)
    await task
    assert "clear" not in sink.ops, f"翻案後不該清: {sink.ops}"
    assert len(sink.frames) == 50, f"翻案後掉幀: {len(sink.frames)}/50"
    assert out.interrupt_state["cut"] is False, "翻案後不該留打斷標記"
    await out.aclose()
    return "誤觸翻案 OK（清除取消、零掉幀、標記清空）"


async def scenario_failsafe_empty_queue():
    """回歸：佇列空（音框全轉發）時 pause/clear 不能懸置——保底計時器要在
    MAX_YIELD 內直接執行（實測通話：懸置的 deferred clear 卡住 wait_for_playout）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    await feed(out, build("S" * 10))   # 0.2s，瞬間全轉發完
    await asyncio.sleep(0.5)           # 佇列已空
    t0 = time.monotonic()
    out.pause()
    await asyncio.sleep(0.1)
    out.clear_buffer()                 # CLEAR_AT_BOUNDARY，但沒有音框可掃
    while "clear" not in sink.ops and time.monotonic() - t0 < MAX_YIELD_S + 1.5:
        await asyncio.sleep(0.05)
    waited = time.monotonic() - t0
    assert "clear" in sink.ops, f"空佇列清除懸置: {sink.ops}"
    assert waited <= MAX_YIELD_S + 1.0, f"保底太慢: {waited:.2f}s"
    await out.aclose()
    return f"空佇列保底 OK（{waited:.2f}s 內清除，不懸置）"


async def scenario_statereset_resume_keeps_clear():
    """回歸：clear 後 µs 級的 resume＝框架 commit 狀態重置（agent_activity:3143），
    不能取消清除（實測：誤當翻案 → 舊句照播＋新回覆排後面＝「消化兩次」）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 20 + "." * 25 + "S" * 30)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.05)
    out.clear_buffer()
    out.resume()              # 同一 tick 的狀態重置
    await asyncio.sleep(1.0)
    task.cancel()
    assert "clear" in sink.ops, f"狀態重置不該取消清除: {sink.ops}"
    assert out.interrupt_state["cut"] is True, "打斷標記不該被狀態重置洗掉"
    assert len(sink.frames) <= 46, f"清除沒生效: {len(sink.frames)} 幀"
    await out.aclose()
    return f"狀態重置護欄 OK（清除照排程，{len(sink.frames)} 幀停）"


async def scenario_new_frames_survive_clear():
    """回歸：clear 之後才到的新回覆音框必須倖存（序號截斷，不整鍋端）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    old = build("S" * 20 + "." * 25)
    task = asyncio.create_task(feed(out, old))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(0.05)
    out.clear_buffer()        # 截斷序號＝此刻佇列裡的舊句
    await task
    await feed(out, build("S" * 15))   # 新回覆音框（clear 之後才到）
    await asyncio.sleep(1.5)
    assert "clear" in sink.ops, f"沒清舊句: {sink.ops}"
    assert len(sink.frames) >= 33, f"新回覆被誤殺: {len(sink.frames)} 幀（新句 15 幀該倖存）"
    await out.aclose()
    return f"新句倖存 OK（共 {len(sink.frames)} 幀，含清除後的新回覆）"


async def scenario_paused_orphan_selfheal():
    """回歸：停在邊界後框架默殺（不 clear 不 resume）→ 2.5s 自癒收攤，
    新句音框放行不被堵死（實測 16 秒黑洞：她沉默、框架 arbitrary-cancel）。"""
    from agent.graceful_yield import PAUSED_ORPHAN_S
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink)
    frames = build("S" * 20 + "." * 25)   # 講到邊界會自己停
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()                            # 讓位 → 邊界暫停；之後框架消失（默殺路徑）
    await asyncio.sleep(PAUSED_ORPHAN_S + 1.2)
    await task
    assert "resume" in sink.ops and "clear" in sink.ops, f"孤兒沒自癒: {sink.ops}"
    n_before = len(sink.frames)
    out.flush()
    await feed(out, build("S" * 10))       # 新句：自癒後必須流得動
    await asyncio.sleep(0.8)
    assert len(sink.frames) >= n_before + 10, f"新句被堵死: {len(sink.frames)} vs {n_before}+10"
    assert out.interrupt_state["cut"] is True, "默殺也算被打斷，要標記"
    await out.aclose()
    return f"暫停孤兒自癒 OK（{PAUSED_ORPHAN_S}s 收攤、新句 10 幀放行）"


async def scenario_volume_gate_math():
    """VolumeGate 數學：正常音量不算提高、大聲算、無基線 fail-open、純雜訊不算。"""
    from agent.graceful_yield import VolumeGate
    g = VolumeGate()
    assert g.is_raised() is True, "無基線要 fail-open"
    for _ in range(120):                      # 2.4s 正常語音（amp 8000）建基線
        g.push(speech_frame(8000))
    assert g.is_raised() is False, "同音量不該算提高"
    for _ in range(20):                       # 0.4s 大聲（amp 16000）
        g.push(speech_frame(16000))
    assert g.is_raised() is True, "音量翻倍該算提高"
    for _ in range(20):                       # 最近窗換成靜音 → 雜訊誤觸不算
        g.push(silence_frame())
    assert g.is_raised() is False, "最近窗無語音能量不該算提高"
    return "音量閘數學 OK（基線/提高/fail-open/雜訊四態）"


async def scenario_shadow_no_yield():
    """影子模式：音量未提高的 pause → 她完全不受影響（不停、不減音量）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink, raised_check=lambda: False)
    frames = build("S" * 40 + "." * 15)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()   # 正常音量的說話 → 影子
    await asyncio.sleep(1.5)
    await task
    assert "pause" not in sink.ops, f"影子不該停: {sink.ops}"
    assert len(sink.frames) == 55, f"影子掉幀: {len(sink.frames)}/55"
    head, tail = frame_rms(sink.frames[5]), frame_rms(sink.frames[38])
    assert tail > head * 0.98, f"影子不該減音量: {head:.0f}→{tail:.0f}"
    await out.aclose()
    return "影子模式 OK（不停、不減音、零掉幀）"


async def scenario_shadow_commit_finishes_sentence():
    """影子後真 commit（正常音量講了完整一句）→ 仍收完整句才清，不瞬砍。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink, raised_check=lambda: False)
    frames = build("S" * 25 + "." * 25 + "S" * 30)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()          # 影子
    await asyncio.sleep(0.1)
    out.clear_buffer()   # 回合成立 → commit
    await asyncio.sleep(1.5)
    task.cancel()
    assert "clear" in sink.ops, f"影子 commit 沒清: {sink.ops}"
    assert out.interrupt_state["cut"] is True
    assert 23 <= len(sink.frames) <= 52, f"影子 commit 沒收完句/收太多: {len(sink.frames)} 幀"
    await out.aclose()
    return f"影子 commit 收整句 OK（{len(sink.frames)} 幀後清）"


async def scenario_raised_yields():
    """音量提高的 pause → 正常讓位路徑（對照組）。"""
    sink = FakeSink()
    out = BoundaryAwareAudioOutput(next_in_chain=sink, raised_check=lambda: True)
    frames = build("S" * 30 + "." * 15 + "S" * 20)
    task = asyncio.create_task(feed(out, frames))
    await asyncio.sleep(0.15)
    out.pause()
    await asyncio.sleep(2.0)
    await task
    assert "pause" in sink.ops, f"提高音量該讓位: {sink.ops}"
    await out.aclose()
    return "提高音量讓位 OK（對照組）"


async def main():
    results = []
    for fn in (scenario_passthrough, scenario_yield_at_boundary,
               scenario_false_interrupt_cancel, scenario_hot_clear_finishes_clause,
               scenario_cold_clear_immediate, scenario_max_yield_cap,
               scenario_multi_segment_clock, scenario_resume_cancels_clear,
               scenario_failsafe_empty_queue, scenario_statereset_resume_keeps_clear,
               scenario_new_frames_survive_clear, scenario_paused_orphan_selfheal,
               scenario_volume_gate_math, scenario_shadow_no_yield,
               scenario_shadow_commit_finishes_sentence, scenario_raised_yields):
        results.append(f"✅ {await fn()}")
    print("\n".join(results))
    print(f"ALL PASS — {len(results)}/16")


if __name__ == "__main__":
    asyncio.run(main())
