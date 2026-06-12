"""
ailivex-realtime-agent-v2 — 即時語音 2.0 啟動入口（主動插話 / 群聊實驗版）

與 v1 完全隔離：不同 agent_name（ailivex-realtime-v2）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v2 start

用法：
  python -m agent.main_v2 dev    # 本地開發
  python -m agent.main_v2 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v2 import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime-v2",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        drain_timeout=30,
        # 掛斷後 job 子行程的關閉寬限：要容得下記憶收尾（快存逐字稿 + 兩通 bridge 提煉）。
        # 預設 10s 會把提煉中途 SIGKILL → lastSession/記憶寫不進去（2026-06-11 撥測抓到）。
        shutdown_process_timeout=90.0,
    ))
