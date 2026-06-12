"""
ailiveX realtime agent — 啟動入口

Cloud Run 用法:  python -m main start
本機開發用法:    python -m main dev
"""
import os
from livekit.agents import cli, WorkerOptions
from src.realtime_agent import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime",
        port=port,
    ))
