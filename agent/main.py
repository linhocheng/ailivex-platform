"""
ailivex-realtime-agent — LiveKit Agent 啟動入口

用法：
  python -m agent.main dev    # 本地開發
  python -m agent.main start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent import entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name="ailivex-realtime",
        port=port,
        # Cloud Run 冷啟動：torch(silero)+firebase-admin grpc import 會超過預設 10s
        # → job 子進程在 initialize 階段被 SIGUSR1 殺，永遠 prewarm 不起來。
        # 拉長 init 超時 + 只 prewarm 一個 idle proc，避免多進程同時 import 互搶 1 vCPU。
        initialize_process_timeout=60.0,
        num_idle_processes=0,
        # 預設 drain_timeout=1800s（30 分）→ 舊 revision 被取代後殭屍 worker 還掛 30 分
        # 仍註冊搶 dispatch，造成一半通話打到死 worker。縮短到 30s 讓部署即時收屍。
        drain_timeout=30,
    ))
