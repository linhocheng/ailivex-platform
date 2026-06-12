FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --target /deps -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /deps /deps
ENV PYTHONPATH=/deps:/app
COPY . .
CMD ["python", "-m", "main", "start"]
