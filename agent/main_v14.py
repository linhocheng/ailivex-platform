"""
ailivex-realtime-agent-v14 — 即時語音 12.0 啟動入口（= v3 + 讀網址工作臺 source intake）

與其他版本完全隔離：不同 agent_name（ailivex-realtime-v14）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v14 start

用法：
  python -m agent.main_v14 dev    # 本地開發
  python -m agent.main_v14 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v14 import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime-v14",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        drain_timeout=30,
        # 掛斷後 job 子行程的關閉寬限：要容得下記憶收尾（快存逐字稿 + 兩通 bridge 提煉）。
        # 預設 10s 會把提煉中途 SIGKILL → lastSession/記憶寫不進去（2026-06-11 撥測抓到）。
        shutdown_process_timeout=90.0,
    ))
