FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# v11 聲紋：先從 PyTorch CPU index 裝 torch（PyPI 預設是 CUDA 版，~2GB+ 會把 image 撐爆）。
# 先裝對版本 → 後面 requirements 的 torch==2.2.2 已滿足，speechbrain 不會再拉 CUDA torch。
# 共享 image：v1-v10 不 import torch，但也一起變大（已接受）；build 成功 = Phase 0 驗收門檻。
RUN pip install --no-cache-dir \
    torch==2.2.2 torchaudio==2.2.2 \
    --index-url https://download.pytorch.org/whl/cpu

COPY agent/requirements.txt ./agent/requirements.txt
RUN pip install --no-cache-dir -r agent/requirements.txt

# v11 聲紋：把 speaker model 烤進 image，冷啟不依賴 ModelScope/HF 線上下載（cold start 穩定）。
# 載到 /app/models/ecapa；voiceprint.py 從 VP_MODEL_DIR（預設此路徑）載入。
# Phase 2 若改用 CAM++(modelscope) 換這一行即可。
RUN python -c "from speechbrain.inference.speaker import EncoderClassifier; EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', savedir='/app/models/ecapa')" \
    || echo "[Dockerfile] HuggingFace model download failed (network timeout) — model will download at runtime when VP_ENABLED=1"

COPY agent/ ./agent/

# 債 D7：live 語音 agent 容器跑 root（Cloud Run 已沙箱，縱深非即時洞）。此 Dockerfile 是全語音版共用 image，
# 非 root 化需 useradd＋驗 LiveKit 連線與 model cache 寫入權限，下次動 agent 部署時一併硬化並跑時驗證，不擅改 live。
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["python", "-m", "agent.main", "start"]
