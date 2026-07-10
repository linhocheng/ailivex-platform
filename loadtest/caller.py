"""
語音負載實測 harness — 階梯式合成來電者。

每個來電者：獨立房間進房 → explicit dispatch 叫 loadtest agent →
循環（播 question.wav → 記 utterance 結束時間 → 偵測 agent 回聲首幀 → turn latency）。
階梯控制器一路加併發：1 路、2 路 … 每階跑滿秒數後全部掛斷、進下一階。

量測定義：
  turn_latency = agent 回聲能量首次越過門檻的時刻 - 我方語音（含尾端靜音）送完的時刻
  stutter      = agent 說話中，音訊幀到達間隔 > 250ms 的次數（破音/卡頓 proxy）
  no_agent     = dispatch 後 20s 內沒有任何 agent 音訊（worker 滿載拒接的信號）

用法（在 ailivex-platform 根目錄）：
  loadtest/.venv/bin/python loadtest/caller.py --rungs 1,2,3,4,5,6 --rung-seconds 180
  --smoke  單路單回合快速驗管道
"""
import argparse
import asyncio
import json
import math
import time
import wave
from pathlib import Path

from livekit import api, rtc
from livekit.protocol.agent_dispatch import CreateAgentDispatchRequest

ROOT = Path(__file__).resolve().parent
USER_ID = "loadtest_user"
CHAR_ID = "loadtest_char"
AGENT_NAME = "ailivex-realtime-loadtest"
SAMPLE_RATE = 48000
FRAME_MS = 10
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
ENERGY_TH = 700          # int16 RMS 門檻：越過視為 agent 在說話
QUIET_AFTER_MS = 1500    # 能量低於門檻持續這麼久 = agent 說完了
STUTTER_GAP_MS = 250
NO_AGENT_TIMEOUT = 20.0
TURN_TIMEOUT = 30.0


def load_env():
    env = {}
    for line in (ROOT.parent / ".env.local").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


def load_wav_frames(path: Path) -> list[bytes]:
    w = wave.open(str(path))
    assert w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
    raw = w.readframes(w.getnframes())
    step = FRAME_SAMPLES * 2
    frames = [raw[i:i + step] for i in range(0, len(raw) - step + 1, step)]
    frames += [b"\x00" * step] * (600 // FRAME_MS)   # 尾端 600ms 靜音給 VAD 斷句
    return frames


def rms(pcm: bytes) -> float:
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    total = 0
    mv = memoryview(pcm).cast("h")
    for s in mv:
        total += s * s
    return math.sqrt(total / n)


class Caller:
    def __init__(self, idx: int, env: dict, speech: list[bytes], run_id: str):
        self.idx = idx
        self.env = env
        self.speech = speech
        self.room_name = f"ailivex-{CHAR_ID}-{USER_ID}-{run_id}-{idx}"
        self.room = rtc.Room()
        self.turns: list[dict] = []
        # agent 音訊狀態（monitor task 維護）
        self.last_loud_at: float | None = None
        self.first_loud_after: float | None = None   # 等待中的 onset 時間戳
        self.awaiting_since: float | None = None
        self.stutters = 0
        self._prev_frame_at: float | None = None
        self._monitor_task = None

    async def _mint_token(self) -> str:
        meta = json.dumps({
            "characterId": CHAR_ID, "userId": USER_ID,
            "convId": f"{USER_ID}_{CHAR_ID}",
            "characterName": "測試員", "voiceId": "",
            "voiceSecondsRemaining": None,
        })
        t = (api.AccessToken(self.env["LIVEKIT_API_KEY"], self.env["LIVEKIT_API_SECRET"])
             .with_identity(USER_ID).with_name("負載測試").with_metadata(meta)
             .with_grants(api.VideoGrants(room=self.room_name, room_join=True,
                                          can_publish=True, can_subscribe=True,
                                          can_publish_data=True)))
        return t.to_jwt()

    def _on_track(self, track: rtc.Track, *_):
        if track.kind == rtc.TrackKind.KIND_AUDIO and self._monitor_task is None:
            self._monitor_task = asyncio.ensure_future(self._monitor(track))

    async def _monitor(self, track: rtc.Track):
        async for ev in rtc.AudioStream(track):
            now = time.monotonic()
            loud = rms(bytes(ev.frame.data)) > ENERGY_TH
            if loud:
                if (self.awaiting_since is not None and self.first_loud_after is None
                        and now > self.awaiting_since):
                    self.first_loud_after = now
                # 卡頓：說話中幀距突然拉大
                if (self._prev_frame_at is not None and self.last_loud_at is not None
                        and (now - self._prev_frame_at) * 1000 > STUTTER_GAP_MS
                        and (now - self.last_loud_at) < 2.0):
                    self.stutters += 1
                self.last_loud_at = now
            self._prev_frame_at = now

    async def _speak(self, source: rtc.AudioSource):
        for f in self.speech:
            await source.capture_frame(rtc.AudioFrame(
                data=f, sample_rate=SAMPLE_RATE, num_channels=1,
                samples_per_channel=len(f) // 2))

    async def _wait_quiet(self, timeout: float) -> bool:
        """等 agent 說完（持續安靜 QUIET_AFTER_MS）。回傳是否等到。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (self.last_loud_at is not None
                    and (time.monotonic() - self.last_loud_at) * 1000 > QUIET_AFTER_MS):
                return True
            await asyncio.sleep(0.1)
        return False

    async def run(self, stop_at: float, max_turns: int, rung: int):
        lk = api.LiveKitAPI(self.env["LIVEKIT_URL"], self.env["LIVEKIT_API_KEY"],
                            self.env["LIVEKIT_API_SECRET"])
        try:
            token = await self._mint_token()
            self.room.on("track_subscribed", self._on_track)
            await self.room.connect(self.env["LIVEKIT_URL"], token)
            source = rtc.AudioSource(SAMPLE_RATE, 1)
            track = rtc.LocalAudioTrack.create_audio_track(f"mic-{self.idx}", source)
            await self.room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))

            dispatch_start = time.monotonic()
            await lk.agent_dispatch.create_dispatch(CreateAgentDispatchRequest(
                agent_name=AGENT_NAME, room=self.room_name,
                metadata=json.dumps({
                    "characterId": CHAR_ID, "userId": USER_ID,
                    "convId": f"{USER_ID}_{CHAR_ID}",
                    "characterName": "測試員", "voiceId": "",
                    "voiceSecondsRemaining": None,
                })))

            # 等 agent 開場白（或至少出聲）；等不到 = worker 拒接/滿載
            t0 = time.monotonic()
            while self.last_loud_at is None:
                if time.monotonic() - t0 > NO_AGENT_TIMEOUT:
                    self.turns.append({"rung": rung, "caller": self.idx, "turn": 0,
                                       "no_agent": True,
                                       "wait_s": round(time.monotonic() - dispatch_start, 1)})
                    return
                await asyncio.sleep(0.2)
            greet_latency = time.monotonic() - dispatch_start
            await self._wait_quiet(timeout=25)

            turn = 0
            while turn < max_turns and time.monotonic() < stop_at:
                turn += 1
                stut_before = self.stutters
                await self._speak(source)
                self.first_loud_after = None
                self.awaiting_since = time.monotonic()
                onset = None
                deadline = self.awaiting_since + TURN_TIMEOUT
                while time.monotonic() < deadline:
                    if self.first_loud_after is not None:
                        onset = self.first_loud_after
                        break
                    await asyncio.sleep(0.05)
                rec = {"rung": rung, "caller": self.idx, "turn": turn,
                       "greet_s": round(greet_latency, 2) if turn == 1 else None}
                if onset is None:
                    rec["timeout"] = True
                else:
                    rec["latency_ms"] = round((onset - self.awaiting_since) * 1000)
                self.awaiting_since = None
                await self._wait_quiet(timeout=25)
                rec["stutters"] = self.stutters - stut_before
                self.turns.append(rec)
                await asyncio.sleep(1.0)
        except Exception as e:
            self.turns.append({"rung": rung, "caller": self.idx, "error": str(e)[:200]})
        finally:
            try:
                await self.room.disconnect()
            except Exception:
                pass
            await lk.aclose()


def summarize(rows: list[dict], rung: int):
    lat = sorted(r["latency_ms"] for r in rows if "latency_ms" in r)
    timeouts = sum(1 for r in rows if r.get("timeout"))
    no_agent = sum(1 for r in rows if r.get("no_agent"))
    errors = sum(1 for r in rows if r.get("error"))
    stut = sum(r.get("stutters", 0) for r in rows)
    if lat:
        p50 = lat[len(lat) // 2]
        p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
        print(f"  第 {rung} 階：{len(lat)} 回合 | p50 {p50}ms | p95 {p95}ms | "
              f"卡頓 {stut} | 逾時 {timeouts} | 拒接 {no_agent} | 錯誤 {errors}")
    else:
        print(f"  第 {rung} 階：無有效回合 | 逾時 {timeouts} | 拒接 {no_agent} | 錯誤 {errors}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rungs", default="1,2,3,4,5,6")
    ap.add_argument("--rung-seconds", type=int, default=180)
    ap.add_argument("--max-turns", type=int, default=10)
    ap.add_argument("--smoke", action="store_true", help="單路單回合驗管道")
    args = ap.parse_args()

    env = load_env()
    speech = load_wav_frames(ROOT / "question.wav")
    run_id = time.strftime("%m%d%H%M")
    out = ROOT / "results" / f"loadtest_{run_id}.jsonl"
    out.parent.mkdir(exist_ok=True)

    rungs = [1] if args.smoke else [int(x) for x in args.rungs.split(",")]
    max_turns = 1 if args.smoke else args.max_turns
    rung_seconds = 60 if args.smoke else args.rung_seconds

    all_rows = []
    for rung in rungs:
        print(f"▶ 第 {rung} 階（{rung} 路併發，{rung_seconds}s）…")
        stop_at = time.monotonic() + rung_seconds
        callers = [Caller(i, env, speech, f"{run_id}r{rung}") for i in range(rung)]

        async def staggered(c: Caller, delay: float):
            await asyncio.sleep(delay)
            await c.run(stop_at, max_turns, rung)

        await asyncio.gather(*(staggered(c, i * 3.0) for i, c in enumerate(callers)))
        rows = [r for c in callers for r in c.turns]
        all_rows += rows
        with out.open("a") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        summarize(rows, rung)
        await asyncio.sleep(5)

    print(f"\n結果檔：{out}")


if __name__ == "__main__":
    asyncio.run(main())
