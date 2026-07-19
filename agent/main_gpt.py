"""
ailivex-realtime-agent-gpt — GPT Voice 線啟動入口

獨立第二條通話線：gpt-realtime 聽想（text-only）＋ MiniMax 發聲。
與所有 vN 完全隔離：不同 agent_name（ailivex-realtime-gpt）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_gpt start

用法：
  python -m agent.main_gpt dev    # 本地開發
  python -m agent.main_gpt start  # 正式環境（Cloud Run）
"""
import os
from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_gpt import entrypoint


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        # 無 prewarm：這條線沒有本地 VAD（turn detection 在 OpenAI 伺服器端）
        agent_name="ailivex-realtime-gpt",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=1,   # 常備熱行程接新通話（同 v16 起的紀律）
        drain_timeout=30,
        # 掛斷後收尾寬限：容得下記憶收尾（快存逐字稿 + 兩通 bridge 提煉），同 v18
        shutdown_process_timeout=90.0,
    ))
