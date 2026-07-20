FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --target /deps -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /deps /deps
ENV PYTHONPATH=/deps:/app
COPY . .
# 債 D7：legacy 快照（非 live，agent_name=ailivex-realtime base），保留一致標記；根治隨 live agent 硬化一起做
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["python", "-m", "main", "start"]
