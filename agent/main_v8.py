"""
ailivex-realtime-agent-v8 — 啟動入口

v6 + 發言權控制（floor control）：被點名抓麥克風 / 交棒第三方就閉嘴。

與 v1-v6 完全隔離：不同 agent_name（ailivex-realtime-v8）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v8 start

用法：
  python -m agent.main_v8 dev    # 本地開發
  python -m agent.main_v8 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v8 import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime-v8",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        drain_timeout=30,
        shutdown_process_timeout=90.0,
    ))
