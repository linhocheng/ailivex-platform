# GPT Voice 線施工計畫

> ★ 已執行完畢並於同日判負退役——歷史入口見 `gpt_voice_line_retrospective_20260716.md`

**日期**：2026-07-16 · **狀態**：已執行→退役（存檔）
**定位**：獨立的第二條通話線（不是 v19）——admin 可控的「GPT Voice」按鈕，與 v18 並存互為對照組。
**配線**：gpt-realtime-2.1 聽＋想（文字輸出）→ **MiniMax 發聲**（Adam 定案：角色聲音是硬需求）。

---

## 一、假設驗證結果（2026-07-16 已完成，文件＋源碼層級）

| 柱 | 假設 | 結果 | 證據 |
|---|---|---|---|
| B① | Realtime API 支援 text-only 輸出 | ✅ | 官方文件原文「Lock the output to audio (set to ["text"] if you want text without audio)」，`session.update` 的 `output_modalities` |
| B② | livekit-plugins-openai==1.5.1 支援指定模型＋text 模態＋輸入轉寫 | ✅ | 源碼實讀：`RealtimeModel(model: str, modalities=["text","audio"]可只給["text"], input_audio_transcription=…)`，模型是自由字串 |
| B③ | AgentSession 能把 realtime 文字流轉送外接 TTS | ✅ | agents 1.5.1 源碼：realtime 無 audio 模態＋有 TTS＝官方支援組合（缺 TTS 才報錯）；realtime 生成路徑呼叫 `perform_tts_inference` → 音訊轉發 |
| B④ | 輸入語音轉寫可得（記憶抽取地基） | ✅ | plugin 內建 `input_audio_transcription`（預設 gpt-4o-transcribe） |

**待 key 實打的三項**（POC 第一天）：
- key 看得到 `gpt-realtime-2.1`（確切 model id 字串以 /v1/models 為準）
- 2.1 接受 1.5.1 plugin 的 session.update 形狀（plugin 用新版 `output_modalities` 欄位，好兆頭，但要實測）
- text-only＋MiniMax 端到端一通冒煙

---

## 二、架構

```
browser ──POST /api/livekit/token {characterId, line:'gpt'}──▶ RoomAgentDispatch{agentName=ailivex-realtime-gpt}
   │                                                            （access.gptVoiceEnabled 才准；session doc 記 line）
   ▼
LiveKit room ◀──joins── Cloud Run: ailivex-realtime-gpt（獨立 service，照版本隔離紀律）
   │              AgentSession(
   │                llm = openai.realtime.RealtimeModel(        ← 聽：語音直進，OpenAI semantic VAD 判回合
   │                        model="gpt-realtime-2.1"(-mini 起步),
   │                        modalities=["text"],                ← 想：只吐文字
   │                        input_audio_transcription=…),       ← 轉寫：記憶抽取用
   │                tts = MiniMaxCustomTTS(voiceIdMinimax…))    ← 說：角色自己的聲音（現有 wrapper 直接掛）
   │              instructions = firestore_loader.build_system_prompt()   ← 靈魂＋七塊記憶，開場注入一次
   ▼
掛斷 → voice-end → 記憶抽取（吃 transcript）＋lastSession 照舊
```

**留在原地不動的**：前端 realtime 頁（多一顆按鈕）、房間拓樸、token 機制、voice-end 收盤、記憶體系、v18 全部。

## 三、施工分解（預估 2-3 天）

**W1 — agent 本體**
- `agent/main_gpt.py`＋`agent/realtime_agent_gpt.py`：**從零寫小的**（~200 行級），不複製 v18 的 710 行——判斷腦/floor-gate/音量閘/3a 都不搬（1:1 專用）。掛 firestore_loader（唯讀共用）、MiniMaxCustomTTS、remember/write_document 兩個 @function_tool。
- `agent/requirements.txt` 加 `livekit-plugins-openai==1.5.1`——**共用檔警戒**：加依賴＝所有版本共用的 image 重建，Cloud Build 綠了才准路由流量（既有紀律）。
- `agent/cloudbuild-gpt.yaml`：service `ailivex-realtime-gpt`，OPENAI_API_KEY 從 Secret Manager 注入（`--update-env-vars` 天條；SA grant secretAccessor）。

**W2 — 平台接線**
- token route：收 `line:'gpt'` → 查 `access.gptVoiceEnabled` → dispatch `ailivex-realtime-gpt`；session doc 寫 `line` 欄位。
- admin：access 管理頁加 GPT Voice 開關（照既有設計系統，不自創樣式）。
- 前端 realtime 頁：有權限時顯示第二顆「GPT Voice」撥號鈕（同頁＝Phase 0 回合打點自動同尺）。
- monitor：回合延遲按 `line` 拆列（v18 vs gpt 並排 p50/p95）——對照組的錶。

**W3 — 驗證與收案**
- 冒煙：實打一通、transcript 落 DB、記憶抽取跑通、成本行進 zhu_vitals_cost（provider=openai）。
- POC 量測（收案信號，先寫死）：
  1. 回合延遲 p50/p95：gpt 線 vs v18，同尺同窗
  2. 人格保真：同角色同劇本 10 輪，走樣處逐條列
  3. 中文聲音：不用測——就是 MiniMax，這個變數已被你的定案消掉
  4. $/min 實測 vs 推估（mini ≈$0.03/min）
- 護欄：OpenAI 後台 hard limit $20（你設）；mini 起步，旗艦要另議。

## 四、風險與退場

- **plugin 形狀不合 2.1** → 退：先用 `gpt-realtime`（plugin 預設、已知相容）跑通線再換模型名；再退：升 plugin 版本得整 image 迴歸驗證（成本高，不輕動）。
- **semantic VAD 中文手感**（回合判定不準/搶話）→ plugin 有 turn_detection 參數可調；仍差則退 server_vad。
- **instructions 撐不住角色**（人格保真輸太多）→ 這就是 POC 的答案本身，線保留當延遲對照組，不轉正。
- **費用失控** → hard limit 硬斷＋每日對 zhu_vitals_cost 錶。
- 任何時刻：這條線下線＝關按鈕＋service 降 0，v18 零影響。

## 五、未決（動工前要清）

1. OpenAI key 驗活＋確認 realtime 模型可見（你跑 `!` 那條，或給新 key）
2. hard limit $20 在 OpenAI 後台設好（只有帳號主人能設）
3. GPT-Live API waitlist 要不要順手登記（免費）
