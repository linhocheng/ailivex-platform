# ailivex「邊聽邊說」藍圖 — GPT 即時語音對接計劃書

**日期**：2026-07-16 · **作者**：築 · **狀態**：計劃書（未動手，等 Adam 拍板）
**前置**：`research_gpt_realtime_vs_ailivex_20260716.md`（對比研究，證據鏈在那份）

---

## 0. 一句話結論

**不換架構，三路並進**：路徑 C（現有 cascaded 上模擬 duplex）先做、路徑 A（gpt-realtime-2.1-mini POC）平行驗證、路徑 B（真 full-duplex）設觸發條件觀望。理由：體感差距的大半來自四個可抄的機制（語意斷句、搶先生成、應和、preamble），抄進來不用犧牲任何資產；而真正的代差（聲學全雙工）今天沒有一條路能在保住角色靈魂的前提下走通。

---

## 1. 差距拆解 → 機制對照表

把「ChatGPT 體感比我們好」拆成五個可各自擊破的機制：

| # | 差距機制 | ChatGPT 的做法 | 我們今天 | 可否不犧牲資產抄過來 |
|---|---|---|---|---|
| G1 | 回合延遲 | 單模型直出＋(2.1) p95 再降 25% | STT→Sonnet→TTS 三段疊加，**回合延遲根本沒量過** | ◑ 縮小可以，歸零不行 |
| G2 | 判斷「講完了沒」 | semantic VAD（語意分類器） | 固定 0.5s 靜音紅綠燈 | ✅ 可抄 |
| G3 | 想的時候不冷場 | preamble（「let me check」）＋邊想邊講 | 工具呼叫/長思考期間死空氣 | ✅ 可抄 |
| G4 | 聽的時候有反應 | full-duplex backchannel（mhmm） | v18 做到「你應和我不停」，反向（我應和你）沒有 | ✅ 可抄（形似神似，非真雙工） |
| G5 | 說話中被插話的語意反應 | 模型每秒多次決策 | 音量閘（物理層），無語意層 | ❌ 這是真代差，C 路徑到不了 |

**路徑 C 的天花板就是 G5**：做完 C，我們是「反應快、會應和、不冷場的輪流制」，不是真雙工。這個天花板值不值得突破，由路徑 A/B 的 POC 數據回答。

---

## 2. 路徑 C — 現有架構模擬 duplex（主線，建議先做）

### 原則

- 照版本紀律開 **v19**，v18 不動（append-only & isolated）。
- 每個機制天條分工：**觸發時機＝確定性程式**，內容生成才給 LLM。
- 共用檔（`conv_tuning.py`、`firestore_loader.py`）只做加法帶預設值。

### Phase 0 — 回合延遲打點（先於一切）

**Why**：天條——宣告「變快了」之前，先有只有變快才會出現的信號。現在連基線都沒有（7/11 只量到首通首音 18s、樣本 1）。

- agent 側打點：`用戶語音結束 → STT final → LLM 首 token → TTS 首 chunk → 出聲`，逐段寫 `voice-metrics`（route 已存在，加欄位即可）。
- 收案信號：/admin/monitor 看得到回合延遲 p50/p95 分佈，至少 30 個真實回合樣本。
- 量級：小（1-2 天內含驗證）。

### C1 — Preamble 填充（G3，性價比最高先做）

- 觸發：`@function_tool` 進入時（write_document、remember、讀網址）＋ LLM 首 token 超過門檻（如 1.5s）未到。
- 做法：`session.say()` 播短語（「我看一下」「等我查查」）——**預先用 MiniMax 合成好、per-voice 快取在 GCS**，不現場合成（零延遲、零額外 TTS 成本）。短語文案從角色 soul 生成一次、Adam 過目。
- 觸發判斷＝純程式（timer＋tool hook），不問 LLM。
- 量級：小。

### C2 — 語意斷句（G2）

- 選項一（優先驗證）：LiveKit Agents 自帶 turn-detector plugin（本地小模型判 end-of-utterance，有多語版）。**施工前先驗**：1.5.1 相容性＋中文效果——這是「標了風險必須真的驗」的那種風險。
- 選項二（fallback）：自建輕量規則＋Haiku 判斷腦打分（interim transcript 尾巴像沒講完 → 動態延長 min_delay；像講完 → 縮短）。判斷腦已存在，加一個用途。
- 與後台 responseSpeed 旋鈕的關係：語意層調的是「在旋鈕值上下浮動」，旋鈕仍是 per 角色基準——共用檔加法。
- 量級：中。

### C3 — 搶先生成（G1）

- LiveKit Agents 有 `preemptive_generation`（endpoint 判定前先拿 interim transcript 開跑 LLM，判定成立直接接上）。**施工前驗 1.5.1 API 形狀**。
- 效果：把「endpointing 0.5s ＋ LLM TTFT」從串行變並行，回合延遲直接砍掉一段。
- 風險：interim 與 final transcript 不一致時白燒 token（Sonnet 直連付費 key）——要量白燒率，超過門檻（如 20%）就關。Phase 0 的打點正好能量。
- 量級：小-中。

### C4 — 反向應和 backchannel（G4）

- 觸發：用戶連續講話超過 N 秒＋子句停頓（VAD 短停但 semantic 判「還沒講完」）→ 低音量播應和聲（「嗯」「嗯嗯」「對」）。
- 素材同 C1：per-voice 預合成快取。觸發＝純程式；頻率上限＋冷卻（防「嗯嗯嗯」轟炸）。
- 已知雷：自己的應和聲會進自己的 STT——v10 回音過濾已擋 agent 自己的 TTS，驗證要覆蓋這條路。
- 這是四個機制裡「演」的成分最高的——形似 full-duplex。建議放最後，做完 C1-C3 看體感還缺多少再決定。
- 量級：中。

### C5 — 首通首音 18s 拆解（獨立痛點，順手排進）

- 兩段式開場：進房先用輕量 prompt（soul 摘要＋固定開場白）秒開口，完整七塊記憶 prompt 背景組好後 `update_instructions()` 熱替換（v17 已有此原語）。
- 量級：中。依 Phase 0 打點數據決定值不值得做（14.7s 到底花在哪要先拆）。

### C 路徑總量級與順序

```
Phase 0（打點）→ C1（preamble）→ C3（preemptive）→ C2（語意斷句）→ 體感評估 → C4（應和）/C5（首通）
```
週級工程，全程 v19 隔離，v18 隨時可回退。**每步收案都要 Phase 0 的錶前後對比**。

---

## 3. 路徑 A — gpt-realtime-2.1-mini POC（平行，驗兩個未知數）

**目的不是切換，是拿數據**。兩個研究答不出來的問題只能實測：
1. **中文（台灣口音）聲音自然度** vs MiniMax——零已驗證來源，只能盲聽。
2. **在 LiveKit 房間拓撲下的真實回合延遲**——官方只給相對值。

### 對接架構（POC 版）

- 開獨立 agent 版本（如 `ailivex-realtime-poc-oai`，不進 VOICE_VERSIONS 正式登錄，走 canary access）。
- LiveKit Agents 有 OpenAI Realtime plugin（`RealtimeModel`）：AgentSession 的 stt/llm/tts 三件換成一個 realtime model，**房間架構、token route、前端全部不動**——這是 LiveKit 架構今天回報我們的地方。
- 靈魂＋記憶注入：`firestore_loader.build_system_prompt()` 產出的文字直接餵 session instructions（128K context 裝得下）；**能不能撐住角色一致性是 POC 要回答的第三個問題**。
- 記憶抽取：Realtime API 有對話 transcript，收尾抽記憶管線理論上可接——POC 驗 transcript 品質。
- 工具：native tool call 支援，remember/write_document 可映射。

### POC 犧牲面（如果之後真切換）

| 資產 | 命運 |
|---|---|
| Claude 角色靈魂（Sonnet 的帶入感） | 換成 OpenAI 的腦，instructions 可控深度未知 |
| MiniMax 中文聲音 | 換 OpenAI voices，POC 盲聽定生死 |
| 判斷腦/floor-gate/防重複（程式層確定性控制） | 多方場景的這套在單模型內蓋不起來——**群聊功能基本不可遷移** |
| bridge 成本結構 | 全直連 OpenAI key |
| 中間文字地基 | 有 transcript 但生成不經文字，Zod 級管控消失 |

### 成本與授權

- 預算粗估：mini ≈$0.03/min（估計值），POC 100 分鐘 ≈ $3-5，加試錯 buffer 抓 **$20 上限**。
- **天條：這需要開 OpenAI 付費 key，等你點頭才開**（現在沒有任何 OpenAI key 在系統裡）。
- 量級：3-5 天（含盲聽測試設計）。

### POC 收案信號（先寫下，防「感覺不錯」）

- 中文盲聽：≥5 人、MiniMax vs OpenAI 同稿對播，勝率數字。
- 回合延遲：同 Phase 0 打點口徑，p50/p95 對比 v18/v19。
- 角色一致性：同一角色同劇本 10 輪，靈魂走樣處逐條列。

---

## 4. 路徑 B — 真 full-duplex（觀望，設觸發條件）

不排工，只設兩個喚醒條件：

1. **GPT-Live API 開放**（已登記 waitlist 的動作可以現在做，免費）→ 屆時看三件事：能否深度控 system prompt、能否拿中間文字、$/min。任一不滿足，對 ailivex 就沒有意義。
2. **中文開源 S2S 成熟**（Moshi 系出現中文社群版，或有人複製 LLM-jp 路徑到中文）→ 屆時評估：~1000 小時中文語料＋訓練資源＋7B 智力上限 vs 屆時的產品需求。今天入場是月級工程＋研究風險，不值。

---

## 5. 決策點（等你拍的）

1. **路徑 C 開工？**（v19，Phase 0 打點先行，不碰 v18）
2. **路徑 A POC 同意開 OpenAI key？**（$20 上限，天條走完授權流程）
3. **GPT-Live waitlist 現在登記？**（免費、零承諾）
4. C4（應和）你的品味判斷：「AI 演應和」在 ailivex 的角色關係語境裡，是加分還是恐怖谷？這題我沒有把握，想聽你的。

---

*本計劃書遵守：三段公式（研究=看現場、本文=寫計畫、排施工=等 GO）；未動任何代碼；所有「施工前先驗」標記處都是已標記的風險，開工時必須真的驗。*
