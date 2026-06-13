"""
ailivex-realtime-agent-v6 — 啟動入口

v5 + 背景思考層（判斷腦 Haiku）+ 主動搶話（開口腦 Sonnet 4.6）。

與 v1-v5 完全隔離：不同 agent_name（ailivex-realtime-v6）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v6 start

用法：
  python -m agent.main_v6 dev    # 本地開發
  python -m agent.main_v6 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v6 import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime-v6",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        drain_timeout=30,
        shutdown_process_timeout=90.0,
    ))
