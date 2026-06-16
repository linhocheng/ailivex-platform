"""v11 聲紋音訊 tap：靠 Agent.stt_node override 拿到「STT 正在吃的那一路 frame」（in-band）。

為什麼用 stt_node override 而非第二條 rtc.AudioStream：LiveKit 官方 echo_transcriber 範例就是這樣
tap——把 audio iterable 包一層，frame 照樣 yield 給 super().stt_node（diarization 不受影響），同時複製一份
餵自己的 VAD/buffer。frame 保證送達（沒有 multi-consumer 在 1.5.1 能不能用的疑慮）。

職責：
  - 收 frame（呼叫端已做回音閘：角色說話時不餵 → 不把自己的 TTS 學成講者，這是第一安全護欄）。
  - 自帶一顆獨立 Silero VAD 切語段（不依賴 session 的 VAD、不靠 Soniox 時戳）。
  - END_OF_SPEECH → 拼語段 → soxr 48k→16k → embed+分群（丟到 thread，不卡 realtime）。
  - 解出 ('#N', conf) 後回呼 on_resolved(ts, label, conf)，讓 agent 用 wall-clock 對齊逐字稿。

Phase 1 煙霧測試：VP_EMBED=0 → 只切語段 + log（不嵌入、不分群），先確認 1.5.1 上 frame 有流、
角色說話時零語段、跟 Soniox final 對得上。Phase 2：VP_EMBED=1 開嵌入分群。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

import numpy as np

logger = logging.getLogger("ailivex-realtime-v11")

VP_EMBED = os.environ.get("VP_EMBED", "1") == "1"   # Phase 1 煙霧測試設 0：只切語段 log，不嵌入


def _frames_to_wav16k(frames: list, target_sr: int = 16000) -> tuple[np.ndarray, float]:
    """一串 livekit AudioFrame（int16 PCM）→ (float32 mono 16k, 秒數)。"""
    if not frames:
        return np.zeros(0, dtype=np.float32), 0.0
    in_sr = frames[0].sample_rate
    ch = getattr(frames[0], "num_channels", 1) or 1
    chunks = [np.frombuffer(f.data, dtype=np.int16) for f in frames]
    pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    if ch > 1:                                   # 多聲道 → 取第一聲道
        pcm = pcm.reshape(-1, ch)[:, 0]
    wav = pcm.astype(np.float32) / 32768.0
    dur = len(wav) / float(in_sr or target_sr)
    if in_sr and in_sr != target_sr and len(wav):
        import soxr
        wav = soxr.resample(wav, in_sr, target_sr).astype(np.float32)
    return wav, dur


class VoiceprintTap:
    """由 stt_node override 推 frame；自跑 VAD loop 切語段、嵌入、分群、回呼。

    echo_active(): 回 True 時呼叫端不該推 frame（角色在說話）——回音閘在 push 端。
    on_resolved(ts, label, conf): 語段解出群後回呼（ts = 語段結束 wall-clock）。
    """

    def __init__(self, engine, *, on_resolved, min_seg: float | None = None,
                 target_sr: int = 16000):
        self._engine = engine
        self._on_resolved = on_resolved
        self._target_sr = target_sr
        from agent.voiceprint import VP_MIN_SEG
        self._min_seg = VP_MIN_SEG if min_seg is None else min_seg

        from livekit.plugins import silero
        # 獨立 VAD（不是 session 那顆）。切語段用，門檻偏穩，短附和不切。
        self._vad = silero.VAD.load(min_speech_duration=0.25, min_silence_duration=0.5)
        self._stream = self._vad.stream()

        self._active = False
        self._seg: list = []
        self._stopped = False
        self._seg_count = 0

    def push_frame(self, frame) -> None:
        """stt_node override 每 frame 呼叫（回音閘已在呼叫端把關，這裡只收真人語音）。"""
        if self._stopped:
            return
        try:
            self._stream.push_frame(frame)
        except Exception as e:
            logger.warning(f"VP tap push_frame failed: {e}")
            return
        if self._active:
            self._seg.append(frame)

    async def run(self) -> None:
        """背景 task：消化 VAD 事件，END_OF_SPEECH → 拼語段 → 嵌入分群。"""
        from livekit.agents.vad import VADEventType
        try:
            async for ev in self._stream:
                if self._stopped:
                    break
                if ev.type == VADEventType.START_OF_SPEECH:
                    self._active = True
                    self._seg = []
                elif ev.type == VADEventType.END_OF_SPEECH:
                    self._active = False
                    frames = list(getattr(ev, "frames", None) or self._seg)
                    self._seg = []
                    ts = time.time()
                    asyncio.create_task(self._process(frames, ts))
        except Exception as e:
            logger.error(f"VP tap run loop error: {e}")

    async def _process(self, frames: list, ts: float) -> None:
        try:
            wav, dur = await asyncio.to_thread(_frames_to_wav16k, frames, self._target_sr)
            if dur < self._min_seg:
                return
            self._seg_count += 1
            if not VP_EMBED or self._engine is None:
                logger.info(f"VP seg#{self._seg_count}: {dur:.2f}s @ts={ts:.2f}（VP_EMBED=0 只 log）")
                return
            res = await asyncio.to_thread(self._engine.embed_and_assign, wav)
            if res is None:
                logger.info(f"VP seg#{self._seg_count}: {dur:.2f}s → 嵌入失敗/降級，無群")
                return
            label, conf = res
            logger.info(f"VP seg#{self._seg_count}: {dur:.2f}s → {label} (conf={conf:.2f}) "
                        f"clusters={self._engine.clusterer.num_clusters}")
            try:
                self._on_resolved(ts, label, conf)
            except Exception as e:
                logger.warning(f"VP on_resolved failed: {e}")
        except Exception as e:
            logger.error(f"VP tap _process error: {e}")

    async def aclose(self) -> None:
        self._stopped = True
        try:
            await self._stream.aclose()
        except Exception:
            pass
