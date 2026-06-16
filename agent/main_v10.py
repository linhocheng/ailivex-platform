"""
ailivex-realtime-agent-v10 — 啟動入口

v9 + 多人房三補強：回音過濾 / 講者身份名冊 / 3a 多人收斂。

與 v1-v9 完全隔離：不同 agent_name（ailivex-realtime-v10）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v10 start

用法：
  python -m agent.main_v10 dev    # 本地開發
  python -m agent.main_v10 start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v10 import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime-v10",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        drain_timeout=30,
        shutdown_process_timeout=90.0,
    ))
