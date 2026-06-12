# ailivex 語音 — 群聊（P2）+ 主動插話（P3）計劃書

> 2026-06-10 · 築 · 基於兩份研究（livekit-agents 1.5.1 原始碼 + CHI 2025 Inner Thoughts 論文 arXiv 2501.00383）
> 現狀：語音 1:1 已上線且語氣優化完成（WS 真串流 + opencc + emotion neutral，revision 00011）。
> 本計劃要過剩下兩關。

---

## 0. 結論先講

- **P2 群聊：必須手搖。** LiveKit AgentSession 1.5.1 在架構上**寫死綁單一 participant**，沒有原生多輸入 API（官方已知缺口 issue #391/#1324）。但提案的拓樸（N 條 listen-only STT + 1 個 STT-less 主 session + 合併 context）是正解，1.5.1 的真實 API 做得到。
- **P3 主動插話：可行，且 3a 不需群聊就能先驗。** 論文架構真實可用；LiveKit 的主動廣播 API 都驗到了。
- **建議序列**：① 先 spike **P3-3a**（1:1 主動廣播管道，~80 行，最便宜去風險）→ ② 蓋 **P2 群聊**（最大工程，是真正價值的地基）→ ③ 疊 **P3-3b**（群聊感知的 Inner Thoughts 評分）。

---

## 0.5 決定定稿（2026-06-10 與 Adam 拍板）

**架構決定：做「即時語音 2.0」獨立平行版，現役 1:1（revision 00011）一個字不碰。**
- 新 `agent_name = ailivex-realtime-v2` + 獨立 Cloud Run 服務 `ailivex-realtime-agent-v2`（同 image、啟動命令 override `python -m agent.main_v2 start`）。
- 前端開「即時語音 2.0」按鈕 → `/realtime-v2/[id]`，token route 加 v2 dispatch。
- 理由：主動插話/群聊是實驗性、會改體感，不拿剛打磨好的 1:1 冒險；要一邊穩定能用、一邊放手實驗。

**Adam 的 5 個決定：**
1. **單房上限 5 人**。
2. **自由聊，性格決定打斷**：角色依立場打斷他人；人也能打斷角色；但「搶話型」原型不客氣、會一直講下去。→ 雙向打斷由 soul 參數驅動。
3. **品質優先，預算無上限**。
4. **soul 雙旋鈕 1–5**：`imThreshold`（多話，5=冷場就想講）+ `interruptThreshold`（搶話，5=別人講一半就切）。鍛造靈魂時從 prompt 自動推預設 + 後台手動 override（像 emotion）。越高越主動。
5. **先 1:1 跑 3a**：練「主動開口 + 打斷/被打斷有回饋」，馬上可試。

**P2 的官方修正（查證後，比初版樂觀）：** 不是「全手搖」。LiveKit 1.5.1 已有官方 recipe：
- `multi-user-transcriber.py`（聽全部人）：每人一條 output 關閉的 session，`RoomOptions(participant_identity=...)` 綁，按 identity 管進出。
- `push_to_talk.py`：`set_participant()` 交發言權。
- 維護者明說沒有 LLM 原生吃多說話者音訊 → label-then-merge。版本最新 1.5.17，能力 1.0 就在、1.5.1 已有，**不為此升級**。
- **唯一真正要自寫**＝transcript 合併 + 「AI 回應誰/何時」協調器（任何版本都沒 turnkey）。

---

## 1. 現狀（現場核過）

`agent/realtime_agent.py` 目前純 1:1：
- `ctx.wait_for_participant()` 等**單一**人（line 114）
- 單一 `AgentSession(stt, llm, tts, vad)`（line 201），內建 turn detection / VAD / interruption 全綁那一條 track
- `userId` 來自 **job dispatch metadata**（一房一人，line 74），**不是** participant.identity
- 唯一的主動發話是開場 `session.generate_reply()`（line 243），其餘全反應式

---

## 2. P2 — 群聊架構

### 2.1 判決：手搖（原始碼佐證）
- `RoomIO` 只綁一個 participant：`RoomInputOptions.participant_identity` 沒給就「綁第一個」（`room_io/types.py:128`）
- `_on_participant_connected` 只 resolve 一次 future，之後的人直接 early-return（`room_io/room_io.py:382-401`）
- audio input 只持有單一 `_participant_identity`，`set_participant()` 是**切換**不是聚合（`_input.py:45,95`、`room_io.py:290-317`）
- → 一個 AgentSession 物理上只吃一個人的音訊

### 2.2 目標拓樸
```
每個 human participant
   └─ rtc.AudioStream → 自己的 soniox.STT().stream() (push_frame loop)
        └─ FINAL_TRANSCRIPT 標上 identity/displayName
            └─→ SharedTranscriptBuffer (asyncio-safe deque)
                  └─→ 協調器（決定 AI 何時開口）
                        └─ agent.update_chat_ctx("Alice: ...\nBob: ...")
                            └─ session.generate_reply()   ← 主 AgentSession = STT-less，只當 LLM+TTS 引擎
```

### 2.3 具體改動（對應真實 API）
1. **動態 participant**：`ctx.wait_for_participant()` → `ctx.room.on("participant_connected"/"disconnected")`。每進一人 spawn 一條 listen-only STT pipeline，離開就拆。
2. **per-participant STT**：每人一個獨立 `soniox.STT()`（各自 WS 連線，**不要**共用一條 stream），手動 `stream().push_frame(frame)`，emit 的 FINAL 標 identity。`stt.STT.stream()` 是公開可單獨驅動的（`stt/stt.py:243,273,407`）。
3. **合併 context**：`agent.update_chat_ctx(chat_ctx)` 可 live 更新（`voice/agent.py:207-233`）。把 buffer flush 成一則帶 speaker label 的 user turn 推回去，再 `generate_reply()`。
4. **主 session 設 STT-less**（或綁一個 dummy/muted identity）避免重複轉錄——它只負責 LLM+TTS，由協調器外部驅動。
5. **speaker ID 免聲紋**：`participant.identity`（JWT 保證）= userId + 各自獨立 track，天然識別。userId 來源從 job metadata 改成 per-participant identity。

### 2.4 三大風險
1. **協調器「AI 何時開口」全靠自己**（#1 風險）。群聊裡 LiveKit 的自動 endpointing 跨不了多說話者。需自建：任一人 FINAL 後 debounce N 秒靜默才觸發。← 這跟 P3 的觸發邏輯是同一塊，兩關在這裡交會。
2. **打斷退化**：`interrupt()`/`allow_interruptions` 綁原本那條 human track；群聊裡 barge-in 不會自動打斷 TTS，要拿 per-participant VAD 手動接 `session.interrupt()`。
3. **回音/串話**：多開麥在同房，AI 的 TTS 和鄰座會滲進彼此 track，STT 可能轉到 AI 自己的聲音。對策：per-track noise cancellation + TTS 播放時 gate 住 STT。

---

## 3. P3 — Inner Thoughts 主動插話

### 3.1 論文（faithful，已核）
"Proactive Conversational Agents with Inner Thoughts"（Liu et al., CHI 2025, arXiv 2501.00383）。
五階段：**Trigger**（每則新訊息 on_new_message / 靜默 on_pause）→ **Retrieval**（記憶按 saliency = 語意相似 × 權重 × 時間衰減）→ **Thought Formation**（System-1 快 + System-2 慢雙路）→ **Evaluation**（G-Eval logit 加權 1–5 評分，8 維：relevance / information-gap / expected-impact / urgency / coherence / originality / balance / dynamics，含 for/against 推理）→ **Participation**（超閾值才說；靜默衰減 `λ^(t−τ)`, λ=1.02，越久沒說話越想說）。

**對同事摘要的修正**：主「多話程度」旋鈕是 **`imThreshold`（1–5）**（開放輪次/靜默時用）；**`interruptThreshold`** 專指**切進別人正在說的話**。兩個都寫進 soul，不同角色不同值。
**注意**：論文是**文字多人聊天**，不是語音；語音的 turn-taking timing 更難。

### 3.2 LiveKit 1.5.1 主動 API（已從原始碼驗）
全在 `voice/agent_session.py`：
- `session.say(text, allow_interruptions=, add_to_chat_ctx=)` → SpeechHandle（line **1019**）：固定文字廣播，無 LLM call
- `session.generate_reply(instructions=, user_input=, ...)`（line **1053**）：可完全主動（開場就在用）
- `session.interrupt(force=False)`（line **1113**）
- `session.current_speech`（line **505**）：非 None = AI 正在說，gate 用
- `session.user_state` / `agent_state`（line **509**；events.py:105-106）+ `session.on("user_state_changed")`
- **沒有** active_speakers pause primitive → 靜默偵測改用 user_state 轉 "listening" + `current_speech is None` + timer

### 3.3 Step 3a（先驗管道，~80 行，1:1 即可）
`user_state_changed` handler → 武裝一個 asyncio debounce timer（1.5s 靜默）→ 便宜 LLM yes/no → `session.say(...)` 或 `generate_reply(...)`，硬 gate `current_speech is None`。目標只是證明「主動廣播管道通」。**不需要群聊，現在 1:1 就能跑。**

### 3.4 Step 3b（真實感）
- 評分跑在**轉錄事件 off turn-path**：在 `conversation_item_added` hook（`realtime_agent.py:206`）`asyncio.create_task(score(...))`，**永不 await 進回話流程** → 正常輪次零延遲。
- **確定性 gating（天條：機制不丟 LLM）**：debounce（有更新的 transcript 就丟舊評分）+ turn-gate（`agent_state != "speaking"` 且 `current_speech is None`）+ cooldown（自發發言間隔下限 8–15s，記 `last_interject_ts`）。
- **評分本身**用 LLM（判斷）：結構化 Haiku 一次回「1–5 分 + for/against + 一句草稿」，soul 的 `imThreshold`/`interruptThreshold` 當閾值。
- **成本對策**：①只在靜默評分不是每則 ②便宜 pre-filter（被點名了嗎？keyword/embedding 相關性）先擋掉再花 LLM ③score+draft 合一次 call ④prompt caching 已開（`caching="ephemeral"` line 143）。

### 3.5 風險 + 對策
| 風險 | 對策 |
|---|---|
| 蓋過人說話（最糟） | 硬 gate `user_state=="speaking"` + `current_speech`；自發發言一律 `allow_interruptions=True`，人一開口立刻讓位；自發絕不 `interrupt(force=True)` |
| 變吵/不自然 | `imThreshold` 預設高（4–5）+ cooldown + 靜默衰減，只在真冷場才開口；保守起步，活潑角色再調低 |
| 延遲 | 評分全 async off-path |
| 成本 | pre-filter + 只靜默評分 + score/draft 合一 |
| 判斷不穩 | LLM 只出分（1–5 + for/against），**go/no-go 由程式定** |

---

## 4. 序列與依賴

```
P3-3a (1:1 主動廣播 spike, ~1-2 天)   ← 最便宜去風險，先證管道
        │
        ▼
P2 群聊 (最大工程, 是地基)            ← 協調器/per-participant STT/合併 context
        │
        ▼
P3-3b (群聊感知 Inner Thoughts 評分)  ← imThreshold/interruptThreshold 進 soul
```
P2 的「協調器：AI 何時開口」與 P3 的觸發邏輯**是同一塊**——蓋 P2 時就把這塊設計成能接 P3 的評分。

---

## 5. 等 Adam 拍板的決策點
1. **單房人數上限**？直接影響成本（N 條並發 Soniox STT 串流）。
2. **群聊回應政策**：AI 什麼時候該回？每次冷場？被點名才回？主持人模式？
3. **成本天花板**：N 條 STT + 每則評分 LLM call 的預算上限。
4. **soul schema**：是否加 `imThreshold` / `interruptThreshold` 兩個 per-character 欄位（後台要不要也開 UI 調，像 emotion 那樣）。
5. **要不要先跑 3a spike** 確認主動發話體感，再決定 P2 投入。

---

*研究來源：livekit-agents 1.5.1 安裝原始碼 + arXiv 2501.00383（CHI 2025）。API 宣稱都附 file:line。*

---

## 6. v3 一吋蛋糕（MVP 執行 · 2026-06-12 Adam 拍板進 v3）

> Adam：「進 v3，先排一吋小蛋糕。」一吋蛋糕＝用最短路徑跑出**一個真實輸出**，去掉最貴的未知，確認口味再量產。

### 6.1 這一吋要證明什麼（唯一目標）
**在 1:1 通話裡，使用者沉默幾秒後，角色能「不請自來」主動播一句話。**
- 機制＝`session.say()`（固定文字、無 LLM）先驗廣播管道本身。
- **這條主動發話路徑至今從沒被端到端驗過**——而它是 v3（群聊插話/內心戲）整條鏈的地基。6/8 那次「招呼語 LLM 串流靜默 hang → 沒聲音」的陰影還在；主動 `say()` 走的是 reply-path 以外的發話，TTS 會不會 fire 是未知數。**用 ~80 行、現在 1:1 就把它驗掉，最便宜去風險。**

### 6.2 二元成功判據（過/不過，不模糊）
- **PASS**：撥 1:1、全程不說話 → 沉默 ~1.5s 後角色**出聲播出那句固定話**（例：「還在嗎？我等你。」），且 **絕不蓋過人**（人一開口立刻讓位）。聽到聲音 = 一吋蛋糕過關，主動廣播管道證實可用。
- **FAIL 三類 + 下一步探針**：
  1. `say()` 的文字進不了 TTS（＝6/8 同類靜默 hang）→ 在 `say()` 前後各埋一行 log，撥一通看斷在哪。
  2. 蓋過使用者在說的話 → gating bug，檢查 `current_speech is None` + `agent_state != "speaking"` 硬閘。
  3. 完全沒觸發 → debounce timer / `user_state_changed` 沒接上，檢查 event 註冊。

### 6.3 平行紀律（同 v1→v2，絕不碰 v2）
- 新 `agent_name = ailivex-realtime-v3`、`agent/main_v3.py`（啟動 override `python -m agent.main_v3 start`）、新 Cloud Run `ailivex-realtime-agent-v3`、`agent/cloudbuild-v3.yaml`。
- 前端 `/realtime-v3/[id]` + chat 頁「3.0」按鈕；token route 加 v3 dispatch（`agent_name=ailivex-realtime-v3`）。
- v2（現役 `ailivex-realtime-agent-v2`）一個字不碰。回滾＝不切流量到 v3 即可。

### 6.4 施工步驟（每步可獨立驗證）
1. `cp main_v2.py main_v3.py`、`cp realtime_agent_v2.py realtime_agent_v3.py`；改 agent_name=v3、entry 指向 realtime_agent_v3。先**原封部署一條 v3**，撥通確認「v3 骨架 = v2 行為」（還沒加主動發話）。
2. v3 agent 內加主動發話：`session.on("user_state_changed")` → 轉 listening/沉默時武裝 asyncio debounce timer（1.5s）→ 觸發時**硬閘**（`current_speech is None` 且 `agent_state != "speaking"`，cooldown ≥10s）→ `session.say("還在嗎？我等你。", allow_interruptions=True)`。**先用固定文字、零 LLM。**
3. 部署 v3 Cloud Run（`cloudbuild-v3.yaml`）+ 前端 3.0 按鈕 + token route v3 dispatch。
4. **撥 1:1、保持沉默 → 聽固定句有沒有播。過了＝一吋蛋糕成立。**
5. （第二口，過關才做）把固定句換成便宜 LLM `generate_reply(instructions=...)` 讓它**接當下話題**主動開口。再過，才談 P2 群聊。

### 6.5 這一吋明確「不做」
評分（8 維 G-Eval）、群聊、per-participant STT、soul 的 imThreshold/interruptThreshold —— 全部等管道證實後再疊。一吋蛋糕只回答一個問題：**主動發話這條管子，通不通。**

---

*v3 一吋蛋糕 scaffold 由築於 2026-06-12 補。Adam 已拍板進 v3、先驗機制。*
