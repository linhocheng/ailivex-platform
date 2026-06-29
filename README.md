# ailiveX

> ⚠️ **此文件已停止維護（內容停在 v2–v4 時期）。**
> 現役版本為 **v14**，架構說明以 `CLAUDE.md` 為準。

以**用戶為中心**的角色記憶 + 即時語音平台。每個用戶 × 每個角色各自記憶、不共享——同一個角色對不同人，記得的事不一樣。

ailive 的精簡重 build：架構從「以角色為中心」翻轉成「以用戶為中心」。

---

## 技術棧

- **前端／API**：Next.js 16 (App Router) · Vercel
- **雲端**：GCP `ailivex-2026`
- **即時語音**：LiveKit Cloud + Python agent (Cloud Run, asia-east1)
  - STT：Soniox `stt-rt-v4`
  - LLM：Anthropic Claude Sonnet 4.6 / Haiku 4.5
  - TTS：MiniMax `speech-2.6-hd`（WebSocket 真串流）+ opencc 繁→簡
  - VAD / turn detection：Silero
- **記憶**：Firestore，嚴格綁 `(userId, characterId)`；Vertex AI embedding
- **文件生成**：對話中 `[[DOCUMENT]]` → doc-worker (Cloud Run) → bridge 生成 markdown → GCS
- **帳號**：scrypt + 簽章 httpOnly cookie，admin 建帳並指派角色

---

## 即時語音版本演進

各版本**完全隔離**：獨立 `agent_name` + 獨立 Cloud Run 服務 + 獨立前端路由。實驗版絕不影響穩定版，可獨立回滾。前端在角色聊天頁以 `語音通話 / 2.0 / 3.0 / 4.0` 按鈕切換。

| 版本 | agent_name / 服務 | 前端 | 現況 | 重點 |
|---|---|---|---|---|
| **v1** | `ailivex-realtime` | `/realtime/[id]` | 線上（快版） | 基礎 1:1 語音，Haiku 低延遲 |
| **v2** | `ailivex-realtime-v2` | `/realtime-v2/[id]` | **現役・端到端通** | 即時語音 2.0：Sonnet 4.6 深度版 · 記憶連貫（上次對話快照 + 上次原話結尾 + 時間感知）· 掛斷記憶收尾釘死 · 後台「對話手感」旋鈕 |
| **v3** | `ailivex-realtime-v3` | `/realtime-v3/[id]` | 實驗・可測 | 擬真主動發話：冷場 backoff 退讓 + 抖動 + soul 驅動（`imThreshold`）· 開不開口交 LLM 看脈絡判斷 · 禁通用罐頭、要從上下文長出具體話 |
| **v4** | `ailivex-realtime-v4` | `/realtime-v4/[id]` | 實驗・測試中 | 單機群聊：Soniox speaker diarization + LiveKit 內建 `MultiSpeakerAdapter`，一支手機多人辨識（**不需聲紋建檔**），LLM 看得到「另一位 #N」在講 |

### v2 — 即時語音 2.0（現役）
深度靠「真的在聽」，口氣平實不演。記憶連貫的關鍵是把 ailive 的「上次對話」設計搬進來：
- **【上次對話】快照**：summary / 結尾氣氛 / 未完話題
- **【上次聊到最後·原話】**：注入逐字稿尾，從真話接而非念摘要
- **最新未完第一優先**，不扯回更舊的話題
- 掛斷記憶收尾：`shutdown_process_timeout=90s` 容得下掛斷後的 LLM 提煉；finalize idempotent、先秒存逐字稿再並行萃取

### v3 — 擬真主動發話
冷場時角色像真人一樣會找話、被晾久了懂得退讓、甚至按性格選擇安靜：
- **節奏（確定性程式）**：冷場 baseline 開口 → 沒回應間隔 ×2.1 退讓 → 封頂 ~2 分鐘，±25% 抖動；用戶一開口整個歸零
- **判斷（LLM）**：是否開口、說什麼，看最近逐字稿 + 已被晾多久；越被晾語氣越淡、越懂給空間
- **性格（soul）**：`imThreshold` 1–5 決定主動程度（im=5 冷場就開口、im=3 偏內斂）
- 主動句禁通用問候（在嗎／還好嗎），必須從上下文、角色、當下默契長出來

### v4 — 單機群聊（測試中）
不靠聲紋生物辨識，而是 **diarization（分得出不同聲音）+ 自報名**：
- Soniox `enable_speaker_diarization=True` → 每段逐字稿帶 `speaker_id`
- LiveKit `MultiSpeakerAdapter` 包住 STT：主說話者照常、其他人標成「（旁邊另一位 #N）」餵進 LLM
- 角色被告知現場可能多人、會問還沒自介的人怎麼稱呼、分得清誰是誰
- 一支手機即可，多人圍著講（共處一室場景）。即時 diarization 會先標錯、講久才穩

---

## 目錄

```
src/app/              Next.js App Router（chat / realtime[-v2/v3/v4] / admin / documents）
src/lib/              memory / collections / documents / auth / livekit
agent/                Python 即時語音 agent（main_v{2,3,4}.py + realtime_agent_v{2,3,4}.py）
cloud-run/doc-worker/ 文件生成 worker
docs/                 架構與計劃（記憶架構 / 語音群聊計劃 / 頁面設計）
```

> 各代語音 agent 共用同一 image，靠啟動命令 `python -m agent.main_vN start` 區分。

---

## 部署

- **前端**：`npx vercel --prod --yes`
- **語音 agent**：`gcloud builds submit --config=agent/cloudbuild-vN.yaml --substitutions=COMMIT_SHA=... .`
- 密鑰走 GCP Secret Manager（runtime 注入），**不入庫**。
