# ChatGPT 即時語音 vs ailivex 即時語音 — 深度對比研究報告

**日期**：2026-07-16 · **作者**：築 · **方法**：deep-research workflow（104 agents、22 個來源、110 條 claim 抽取、25 條進 3 票對抗驗證、24 條存活）
**內部側**：以現役 v18 代碼為準（`agent/realtime_agent_v18.py`、`conv_tuning.py`），不是記憶。

---

## TL;DR

1. **你體感到的「邊聽邊說邊想」是真的，而且是 8 天前才換代的**：2026-07-08 OpenAI 推出 **GPT-Live**（GPT-Live-1 / mini），取代 Advanced Voice Mode。真 full-duplex——單模型持續同時處理輸入與輸出、每秒多次決策（說/聽/打斷/叫工具），會用「mhmm」邊聽邊應和；「想」是委派架構：GPT-Live 當嘴，背景丟給 GPT-5.5 推理，對話不斷線。
2. **但 GPT-Live 沒有 API**。今天開發者能接的最新是 **gpt-realtime-2.1**（2026-07-06 發布），它是原生 speech-to-speech 單模型，但屬「**感知雙工**」（preamble 短語＋邊想邊講＋semantic VAD），不是聲學全雙工。
3. **full-duplex 已是可自建技術**（Kyutai Moshi 開源、160-200ms、日文改造已被走通），但 prototype 級、7B 智力遠低於 Claude。
4. **OpenAI 官方文件親自背書我們現有 cascaded 架構的優勢**：中間文字掌控、複用 text agent、可稽核 transcript、確定性邏輯——正是 ailivex 的角色靈魂＋記憶系統＋天條工程賴以存在的地基。
5. **結論：有可取之處，但不是換掉架構，是三路並進**——C（cascaded 上模擬 duplex，保全資產）先做、A（gpt-realtime-2.1-mini POC）驗中文聲音、B（Moshi 系/GPT-Live API）觀望。藍圖見 `blueprint_duplex_voice_20260716.md`。

---

## 一、外部側：ChatGPT 語音現在是什麼

### 1.1 GPT-Live（ChatGPT App 內，2026-07-08 起）

| 項目 | 內容 | 信度 |
|---|---|---|
| 模型 | GPT-Live-1（付費預設）/ GPT-Live-1 mini（免費預設），取代 AVM | high 12-0 |
| 架構 | **真 full-duplex**：單模型連續處理輸入同時生成輸出，每秒多次互動決策 | high 12-0 |
| 邊聽邊回 | backchannel：「mhmm」「yeah」應和；用戶思考時保持安靜 | high |
| 邊想 | **委派架構**：需要搜尋/推理時丟給背景 GPT-5.5（Instant/Medium/High 檔），GPT-Live 繼續陪聊 | high 3-0 |
| API | **未開放**，官方只說 soon＋登記表單 | high 6-0 |

官方同時明言：前代 AVM 仍是 turn-based（靠靜音判定回合、會在不自然時機插話）——full-duplex 是這一代才有的。

> 來源：openai.com/index/introducing-gpt-live/ · deploymentsafety.openai.com/gpt-live · TechCrunch 2026-07-08

### 1.2 gpt-realtime-2.1（Realtime API，開發者今天能接的最新）

| 項目 | 內容 | 信度 |
|---|---|---|
| 本質 | 原生 S2S 單模型（聽想說一體，非 cascaded），「第一個 GPT-5 級推理的語音模型」 | high 11-1 |
| 互動模型 | **感知雙工**：邊對話邊推理、平行工具呼叫、preamble（「let me check that」）、打斷恢復。**不是**聲學全雙工——模型不會在用戶說話同時出聲 | high |
| turn detection | 平台級內建：server_vad（靜音長度）＋ **semantic_vad**（語意分類器判「講完了沒」，尾音 ummm 自動延長等待） | high 6-0 |
| context | 128K（前代 32K）、五檔 reasoning（minimal→xhigh，預設 low） | high |
| 延遲 | 官方只給相對值：p95 較前代降 ≥25%，**無絕對 ms** | — |
| 價格 | 音訊 $32/$64 per 1M tokens（cached input $0.40）；**mini $10/$20**；文字 $4/$24 | high 12-0 |

**每分鐘成本粗估**（沿用舊世代官方換算比率推導，標估計值）：
- 2.1 旗艦：聽 ≈$0.019/min＋說 ≈$0.077/min → **≈$0.10/min 級**
- 2.1 mini：聽 ≈$0.006/min＋說 ≈$0.024/min → **≈$0.03/min 級**
- 實際帳單由累積 context 重算＋cache 命中率主導（第三方 4000 sessions 實測確認），以 POC 實測為準。

### 1.3 自建 full-duplex 的現況（Moshi 系）

- Kyutai Moshi：單模型雙音訊流（自己說＋用戶說同時建模），理論延遲 160ms、L4 實測最佳 ~200ms（有人量到 11s+，最佳情況值）；MIT/Apache-2.0＋CC-BY 權重，PyTorch 需 ~24GB 顯存。
- **換語言路徑已走通**：LLM-jp-Moshi（日本 NII，2026-02）用 ~1000 小時日文語料把英文 7B Moshi 改造成日文 full-duplex——中文理論可複製，但產出 prototype 級（官方自述回應可能不自然），7B 智力遠低於 Claude。
- 生產界現況：cascaded＋semantic-VAD 仍是主流，S2S 模型智力普遍低於其 text backbone。

---

## 二、內部側：ailivex v18 現場鐵地（記憶修正版）

| 項目 | 現場（以代碼為準） |
|---|---|
| STT | **Soniox stt-rt-v4**（diarization on）——不是記憶裡的 Deepgram |
| LLM 回合路 | **Sonnet 4.6 直連付費 key**（v2 深度版換掉 Haiku）；判斷腦/3a/收尾抽取＝Haiku 走 bridge |
| TTS | MiniMax **speech-2.6-hd**，WS 串流＋REST SSE fallback，繁→簡 opencc |
| 互動模型 | **half-duplex＋音量閘打斷**（v18 interrupt_gate：應和聲不停、更大聲才停；誤觸 1.2s 自動接回）＋讓位/floor-gate/判斷腦 |
| endpointing | 固定 min_delay，後台旋鈕 0.2–0.8s（預設 0.5s）——**無語意層** |
| 延遲基線 | connect 3.3s；首通首音 18s（14.7s 在 agent 首回合內部，含靈魂+記憶組 prompt；樣本 1）；**每回合延遲未拆點量測** |
| 資產 | 角色靈魂（soul 全文可控）＋七塊記憶 prompt＋日記＋遺忘曲線＋多方 floor 控制＋文件工具——全部依賴「中間文字」存在 |

---

## 三、逐維度對比

| 維度 | ChatGPT（GPT-Live） | gpt-realtime-2.1 | ailivex v18 |
|---|---|---|---|
| 互動模型 | 真 full-duplex | 感知雙工 | half-duplex＋音量閘 |
| 邊聽應和 | 有（backchannel） | 無 | 無（v18 做到「應和不打斷我」，反向沒有） |
| 首音延遲 | 無公開數字 | 無絕對數字（p95 降 25%） | 首通 18s（首回合含組 prompt）；回合延遲未量 |
| turn detection | 模型原生連續決策 | semantic_vad 平台級 | 固定秒數 endpointing |
| 可打斷性 | 原生 | 原生＋恢復 | 音量閘＋誤觸恢復（1.2s） |
| 中文聲音 | 未知 | 未知（**無任何已驗證來源覆蓋中文自然度**） | MiniMax 中文/台灣口音，現有優勢 |
| 角色靈魂 | 不可控 | system instructions（深度可控性待 POC） | **soul 全文＋七塊記憶＋日記，完全掌控** |
| 長期記憶 | 不可外掛 | 只能靠 instructions 注入 | 自建完整體系 |
| 換 LLM | 不可 | 不可（綁 OpenAI） | 可（今天就是 Claude） |
| 中間文字 | 無 | 有 transcript 但生成不經文字 | **原生**（一切機制的地基） |
| 成本/min | N/A | 旗艦 ≈$0.10 / mini ≈$0.03（估） | Sonnet token 為大宗＋Soniox＋MiniMax；量級與 mini 相當（以 zhu_vitals_cost 實測為準） |
| 天條相容 | — | 確定性邏輯難插進單模型內 | 判斷腦/floor-gate/防重複全是程式層——**這套在 S2S 上蓋不起來** |

**OpenAI 官方 voice-agents 指南原文**（2026-07-16 實抓、3-0 驗證）：chained 路徑適合「stronger control over intermediate text, existing text-agent reuse, durable transcripts and deterministic logic between each stage」；S2S 路徑適合「barge-in, low first-audio latency, natural turn taking, realtime tool use」。**兩邊的優勢清單，剛好是我們的資產清單 vs 我們的差距清單。**

---

## 四、結論

1. **差距的本質不是「我們慢」，是互動模型代差**：他們一個模型每秒做多次「現在該說還是該聽」的決策；我們是三段流水線＋固定秒數紅綠燈。這個代差靠優化流水線縮不到零。
2. **但我們的資產在他們的架構上蓋不起來**：靈魂全文、七塊記憶、判斷腦＋確定性 floor 控制、換 LLM 自由、bridge 成本結構——全部長在「中間文字」上。gpt-realtime-2.1 的生成不經文字，GPT-Live 連 API 都沒有。
3. **體感差距的大半可以在不犧牲資產的前提下縮小**（semantic endpointing、backchannel、preamble、preemptive generation）——OpenAI 自己的產品拆解證明這些機制單獨存在、可以抄思路。
4. **可取之處成立** → 藍圖進任務二，三路並進，詳見 `blueprint_duplex_voice_20260716.md`。

## 五、Caveats（研究誠實欄）

- GPT-Live 發布僅 8 天，API 時程/價格/可控性全未知，數週內結論可能被改寫。
- openai.com 對爬蟲回 403，多條引文靠二手來源逐字比對驗證。
- 延遲缺絕對值：無法與我們的 3.3s/18s 做同尺度對比；**我們自己的回合延遲也沒量**——先補打點才有對比地基。
- $/min 全是推導估計；Gemini Live / Nova Sonic 的存活 claim 沒覆蓋到（開放問題）。
- gpt-realtime-2.1 中文（台灣口音）自然度 vs MiniMax：**零已驗證來源，只能盲聽 POC**。

## 主要來源

- openai.com/index/introducing-gpt-live/（GPT-Live 官方公告）
- deploymentsafety.openai.com/gpt-live（系統卡）
- openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/（gpt-realtime-2.1）
- developers.openai.com/api/docs/guides/realtime · /realtime-vad · /voice-agents · /pricing
- github.com/kyutai-labs/moshi · kyutai.org/Moshi.pdf · github.com/llm-jp/llm-jp-moshi
- hackernoon.com「OpenAI Realtime API Pricing in 2026: Real-World Data from 4000 Measured Sessions」
