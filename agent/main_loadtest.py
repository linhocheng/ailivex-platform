"""
ailivex-realtime-agent-loadtest — 負載實測專用啟動入口（臨時服務，測完即刪）

行為 = v18 一字不差（直接 import realtime_agent_v18），只換 agent_name 隔離派工：
與生產 v18 共用 LiveKit project 時，靠 agent_name 區隔，loadtest 的合成通話
永遠不會派到生產服務，生產通話也不會派到這裡。

部署：gcloud builds submit --config=agent/cloudbuild-loadtest.yaml --substitutions=COMMIT_SHA=loadtest .
測後：gcloud run services delete ailivex-realtime-agent-loadtest --region=asia-east1

用法：
  python -m agent.main_loadtest dev    # 本地開發
  python -m agent.main_loadtest start  # Cloud Run
"""
import os
from livekit.agents import cli, JobProcess, WorkerOptions
from agent.realtime_agent_v18 import entrypoint, load_vad


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = load_vad()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=prewarm,
        agent_name="ailivex-realtime-loadtest",
        port=port,
        initialize_process_timeout=60.0,
        num_idle_processes=1,
        drain_timeout=30,
        shutdown_process_timeout=90.0,
    ))
