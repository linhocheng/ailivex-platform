"""
ailivex-realtime-agent-v17 — 即時語音 17.0 啟動入口（= v16 + 記憶全景圖語音道：remote 記憶塊＋掛斷日記）

v16 差異：prewarm_fnc 預載 VAD + num_idle_processes=1 常備熱行程（接通延遲）
         + VAD 0.3 / TTS 首段 flush（見 realtime_agent_v17.py）

與其他版本完全隔離：不同 agent_name（ailivex-realtime-v17）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v17 start

用法：
  python -m agent.main_v17 dev    # 本地開發
  python -m agent.main_v17 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, JobProcess, WorkerOptions
from agent.realtime_agent_v17 import entrypoint, load_vad


def prewarm(proc: JobProcess):
    # 子行程起來就把 VAD 載好，每通電話省掉模型載入（v16 延遲優化其一）
    proc.userdata["vad"] = load_vad()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=prewarm,
        agent_name="ailivex-realtime-v17",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=1,   # v16: 常備一個已 prewarm 的熱行程接新通話
        drain_timeout=30,
        # 掛斷後 job 子行程的關閉寬限：要容得下記憶收尾（快存逐字稿 + 兩通 bridge 提煉）。
        # 預設 10s 會把提煉中途 SIGKILL → lastSession/記憶寫不進去（2026-06-11 撥測抓到）。
        shutdown_process_timeout=90.0,
    ))
