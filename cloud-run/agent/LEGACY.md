# LEGACY — Base Agent 快照

此目錄是 **base agent（無版本號）的舊快照**，已停止維護。

- `agent_name`：`ailivex-realtime`（base，無版本）
- 代碼狀態：2024 年底的快照，不反映現役功能
- **不要在這裡做修改**——改動不會進生產

## 現役代碼在哪

```
agent/                    ← 這裡才是 live
  main_v14.py             ← 現役啟動入口
  realtime_agent_v14.py   ← 現役語音 agent
  firestore_loader.py     ← 共用模組（所有版本共享）
  minimax_tts.py          ← TTS 包裝
  multi_party.py          ← 多人房
  conv_tuning.py          ← 對話手感
```

## 為什麼還留著

- Cloud Run 的 doc-worker（`cloud-run/doc-worker/`）在同一個 cloud-run/ 目錄下，需要各自的 Dockerfile
- 這個 agent 快照和 doc-worker 共存在 cloud-run/，是目錄結構的歷史遺留

如果未來確認 `ailivex-realtime`（base service）已從 Cloud Run 下架，這個目錄可以整個刪除。
