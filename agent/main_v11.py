"""
ailivex-realtime-agent-v11 — 啟動入口

v10 + 聲紋講者辨識（voiceprint）：在共享單麥情境下，用聲紋分群當「誰在說話」的真相來源，
把 Soniox 的匿名 #N diarization 降為提示 → 提升 floor-gate / 名冊 / 餵給角色的上下文的準確度。
聲紋全程在 in-call 跑（v11.0）；跨通話「記住常客」+ 同意流程留到 v11.1。kill-switch：VP_ENABLED。

與 v1-v10 完全隔離：不同 agent_name（ailivex-realtime-v11）+ 獨立 Cloud Run 服務。
同一 image，啟動命令 override 成：python -m agent.main_v11 start

用法：
  python -m agent.main_v11 dev    # 本地開發
  python -m agent.main_v11 start  # 正式環境（Cloud Run）
"""
import logging
import os

from livekit.agents import cli, WorkerOptions
from agent.realtime_agent_v11 import entrypoint

logger = logging.getLogger("ailivex-realtime-v11")


def _prewarm(proc) -> None:
    """每個 job 子進程 initialize 階段載入一次聲紋 embedder（REVIEW A）。

    天條：torch 重模型載入放在 prewarm（被 initialize_process_timeout 涵蓋），不要拖到 entrypoint
    害每通電話開場都等模型 → 破壞 realtime 體感。main.py 已記：torch(silero)+firebase import 就曾超過
    預設 10s 被 SIGUSR1 殺；v11 再疊一顆 speaker model，所以把 timeout 拉到 180、idle proc 留 1 顆熱機。

    防禦：VP 關掉、或模型/套件缺失 → 靜默降級成 v10（embedder=None），絕不擋啟動。
    """
    if os.environ.get("VP_ENABLED", "0") != "1":
        proc.userdata["vp_embedder"] = None
        return
    try:
        from agent.voiceprint import load_embedder
        proc.userdata["vp_embedder"] = load_embedder()
        logger.info("prewarm: voiceprint embedder loaded")
    except Exception as e:
        proc.userdata["vp_embedder"] = None
        logger.error(f"prewarm: embedder load failed → 降級 v10（VP off this proc）: {e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=_prewarm,                 # REVIEW A：重模型載入移到 prewarm
        agent_name="ailivex-realtime-v11",
        port=port,
        # v11 疊了第二顆 torch 模型（speaker embedder）→ 冷啟 import/load 更久。
        # main.py 註記過：超過預設 init timeout 會被 SIGUSR1 殺、永遠 prewarm 不起來。
        initialize_process_timeout=180.0,     # REVIEW A：60 → 180
        num_idle_processes=1,                 # REVIEW A：0 → 1，留一顆熱機 proc 把模型載入挪離通話關鍵路徑
        drain_timeout=30,
        shutdown_process_timeout=90.0,
    ))
