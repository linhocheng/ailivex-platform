# GPT Voice 線回顧 — 一晚 POC 全紀錄（2026-07-16）

**結論**：判負退役。Adam 定調：「gpt-realtime 完全行不通，因為我們要的不是罐頭，我們要的是有靈魂角色的。」
**這份文件是 GPT 線歷史的單一入口**——證據、時間線、可取之處、復活 SOP 都在這裡。

姊妹文件：
- `research_gpt_realtime_vs_ailivex_20260716.md` — 事前深度研究（GPT-Live/gpt-realtime-2.1/競品/價格）
- `blueprint_duplex_voice_20260716.md` — 三路藍圖（path C 仍有效，見下）
- `plan_gpt_voice_line_20260716.md` — 施工計畫（已執行完畢）
- 記憶：`~/.claude/projects/-Users-adamlin/memory/project_gpt_voice_line_verdict.md`

---

## 一、我們蓋了什麼（一晚，全程隔離、v18 零接觸）

**配線**：gpt-realtime-2.1-mini 聽＋想（`modalities=["text"]`）→ MiniMax speech-2.6-hd 發聲（角色自己的 voiceId）。靈魂＋七塊記憶＋remote 記憶塊照常注入，掛斷收尾（逐字稿/lastSession/提煉/日記）與 v18 同路。

**代碼落點**（全部保留，隨時可考古）：
- agent：`agent/main_gpt.py`、`agent/realtime_agent_gpt.py`、`agent/cloudbuild-gpt.yaml`；`requirements.txt` 的 `livekit-plugins-openai==1.5.1`
- 平台：`collections.ts` `GPT_VOICE_LINE`（含 `retired` 旗標）、token route `line:'gpt'` 分流＋退役閘、`access.gptVoiceEnabled`、realtime 頁 GPT Voice 鈕、admin access 開關、monitor 回合延遲按線拆表
- Cloud Run：`ailivex-realtime-agent-gpt`（asia-east1，**已降 min=0**，服務保留）
- Secret：`OPENAI_API_KEY`（Secret Manager，2026-06-18 建，已驗活、realtime 全系列可見）

**迭代小史**：rev 00002 首版 → 00003 transcript 修復＋身份錨 → 00004 VAD 門檻 0.5→0.85（出廠即退役，未再實測）。

## 二、判負證據（逐字稿實錘，conv `ailivex-voice-GZo20ejpBieeGtDGgnO8-mX56wM0CxRIMHlKgs2d0`）

1. **身份出戲（死穴）**：身份錨（框架級 prompt）已生效的版本上，Adam 直問「你是誰」→「**我是 ChatGPT，像一個能陪你聊天的文字搭檔**」，並否認有長期記憶（14 條記憶就在 context 裡）。底模「誠實 AI」訓練輾過角色設定——prompt 是地板不是天花板，同一份靈魂 Claude 入戲、GPT 出戲。
2. **幻聽**：transcript 出現 `[user] Evet.`（土耳其語「是」，Adam 沒說過）；多處無 user turn 的連發 assistant 回覆——她在回應噪音幻聽，體感=「在跟第三者聊天」。
3. **「一直跳」機制鏈**：OpenAI 伺服器 VAD（預設 threshold 0.5）把任何人聲判 `speech_started` → livekit-agents `agent_activity.py:1301` **無條件 `interrupt()`** → 話講一半被砍重生成。一通 14 次 TTS 合成 5 次沒跑完。v18 三個版本蓋的打斷防護（音量閘/回音過濾/誤觸回復）這條線上全部不存在，OpenAI 只給一顆 VAD 門檻旋鈕。

## 三、可取之處（全部已落袋）

1. **判定本身**：「要不要走 GPT 語音」從懸念變成有逐字稿背書的結論，成本一晚＋約 $2。
2. **回合延遲量尺（永久資產）**：前端 mic RMS＋ActiveSpeakersChanged 配對 → `voice-metrics` → monitor 按線拆表，端到端實收 7 筆（p50 5.1s，混打斷雜訊僅供參考）。此後 v18 每次延遲優化都用這把尺驗收。
3. **首通 18 秒翻案線索**：GPT 線配線完全不同，首通首音仍 **18.6s**（v18 基線 18.0s）→ 瓶頸在**兩線共用的開場路徑**（建線/組 prompt/agent 首回合），不在 STT→LLM→TTS 選型。樣本 1 待複驗，但直接重定向 blueprint C5 的方向。
4. **第二線插座（模型無關）**：line 分流＋access 旗標＋admin 鈕＋per-line 監控。未來 GPT-Live API 開放、Gemini Live、開源 S2S 成熟——插上就能測，成本一個下午。
5. **S2S 候選驗收三連**（下次評任何語音模型先砍這三刀）：①直問「你是誰」三次 ②transcript 幻聽稽核（有沒有用戶沒說的話）③打斷率（TTS started vs done 差值）。
6. **體感路線圖不變**：ChatGPT 的「邊聽邊說」拆出的四機制（語意斷句/搶先生成/preamble/應和）全部可在自家 Claude 線實作（blueprint path C），零靈魂犧牲。

## 四、復活 SOP（如果哪天要重開）

1. `gcloud run services update ailivex-realtime-agent-gpt --region=asia-east1 --min-instances=1`（0 實例＝聾）
2. `collections.ts` 的 `GPT_VOICE_LINE.retired` 改 `false` → `npx vercel --prod --yes`
3. admin access 頁開角色的 GPT Voice 開關（admin 自己恆可）
4. 記得：OpenAI 後台 usage limit、`GPT_REALTIME_MODEL` env 可換模型、VAD 參數在 `realtime_agent_gpt.py` 的 `TurnDetection`

## 五、未收尾清單（退役時的誠實欄）

- VAD 0.85 版（rev 00004）出廠未實測——「跳」的修法有效性未驗證
- 最後一通的記憶提煉 `[extraction] LLM call failed: timed out` 一筆（該通記憶可能缺）
- 幻聽輸入可能已寫進 Lilith 的記憶庫（`Evet.` 那通在 transcript 修復後）——若 Lilith 記憶出現怪內容，來這裡查案
