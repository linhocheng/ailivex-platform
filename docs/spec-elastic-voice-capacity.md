# 即時語音彈性容量 — 設計規格書＋負載實測方法論

**版本**：v1.0（2026-07-11）
**來源**：AILiveX 生產系統（LiveKit + Cloud Run + Firestore），已上線運行、實彈驗證過
**對象**：要在自己平臺蓋同一套的工程師＋他的 AI。第三方組成類似（WebRTC 房間服務＋常駐語音 agent＋serverless 平臺後端＋NoSQL）即可直接套用
**讀法**：人類讀第一～五章（why + how），AI 直接吃第六章（機讀規格）＋第四章（校準數據）

---

## 第一章 原理：為什麼要這樣設計（三條物理）

**1. 語音 agent 睡著＝聾，不是慢。**
即時語音 agent 是「常駐連線、主動領工」模式（worker 向 WebRTC 雲註冊待命）。縮到 0 台時派工根本送不到——用戶按通話鍵永遠沒人接。所以彈性有地板：**營業中至少 1 台醒著**，這台的錢買的是「下一秒接得起」。彈性系統的目標是把「地板以上的浪費」和「沒人時段的地板」都省掉。

**2. 真正的容量殺手是「同一秒湧進來」，不是「同時在講」。**（實測發現，見第四章）
每通新電話的建線（開子行程＋載入角色/記憶＋首輪推理）是 CPU 尖刺；穩態通話反而便宜。我們實測：6 路同時「講」毫無劣化，但 6 通在 15 秒內「建線」讓首回合延遲從 4 秒飆到 27 秒。**結論：加機器必須發生在劣化之前**，所以升檔觸發點不能是 CPU 指標（落後），必須是「有人要打電話」這個領先指標。

**3. 原生 autoscaler 是落後指標，只能當第二道保險。**
雲平臺的自動擴容看 CPU/請求數——它出手時通話已經在劣化。自建調節器看「房間數對容量比」，在用戶感受到之前行動。

---

## 第二章 設計規格

### 2.1 狀態機：三段變速箱

```
        ┌────────────┐  admin 開機 / 排程開機   ┌────────────────────┐
        │   關機     │ ───────────────────────▶ │      待命           │
        │ min=0      │ ◀─────────────────────── │ min ∈ [1, MAX]      │
        │ 旗標 off   │  閒置>3h 自動關機(cron)   │ 調節器自動調         │
        └────────────┘                          └────────┬───────────┘
                                                admin 按鈕 │ ▲ 到期自動回(cron)
                                                          ▼ │  或手動退
                                                ┌────────────────────┐
                                                │      活動           │
                                                │ min=MAX，限時鎖定    │
                                                └────────────────────┘
```

| 檔位 | min-instances | 進入方式 | 退出方式 | 用途 |
|---|---|---|---|---|
| 關機 | 0 ＋功能旗標 off | 閒置自動 / admin | admin 開機（開機必重置待命底檔） | 深夜、無客戶 |
| 待命 | 1..MAX 調節器自動 | 開機預設 | — | 平常營業 |
| 活動 | MAX，鎖定 | admin 一鍵（帶時數） | **到期 cron 自動降回**（也可手動） | 發表會/demo |

**不變量：活動檔必須自動退出。** 任何「拉高常駐」的操作若沒綁到期時間＋自動回收，就是下一台忘了關的殭屍燒錢機。

### 2.2 資料模型（NoSQL 兩個 config doc）

```
config/voicePower   { on: bool, onSince, lastCallAt, autoOffHours, updatedBy }   ← 既有電源層
config/voiceCapacity {
  desiredMin: number          # 調節器目前決定的 min（1..MAX）
  eventMode: { min, until } | null   # 活動檔：鎖定值＋到期時間（ISO）
  lowWaterSince: string | null       # 低水位起算點（降檔觀察窗）
  updatedAt, updatedBy        # 'regulator-up'|'regulator-down'|'event'|'event-expire'|'power-on'|'admin'
}
```

**真相分層**：`desiredMin` 是「意圖」，雲平臺 API 回讀的 minInstanceCount 才是「真相」。所有驗證讀真相，不讀意圖。

### 2.3 調節規則（核心邏輯，共四條）

| # | 規則 | 觸發點 | 條件 | 動作 |
|---|---|---|---|---|
| R1 升檔 | 發 token 的瞬間（回應後非同步跑，不拖慢發 token） | (現役房間+1) ≥ 目前容量 × **0.7** | desiredMin+1（≤MAX）→ PATCH 雲平臺 |
| R2 降檔 | 定時巡檢（30 分/輪） | 房間 < 目前容量 × **0.4** 持續 ≥ **60 分** | desiredMin−1（≥1）→ PATCH |
| R3 活動檔到期 | 同一巡檢 | now > eventMode.until | 清 eventMode、desiredMin=1 → PATCH |
| R4 開機重置 | admin 開機 | — | desiredMin=1、清 eventMode/lowWaterSince |

其中「目前容量」= `max(desiredMin, 雲平臺真值 min) × 每台安全路數`。

**設計要點（每條都有理由）：**
- **R1 釘在發 token**：這是全系統唯一撥號咽喉，也是最早的需求信號——新台在這通電話建立前就開始暖，正好接下一通（對策就是第一章物理 2）
- **升檔用 DB transaction**：兩通電話同一秒進來會觸發兩次 R1，transaction 序列化 desiredMin 讀寫，防雙升
- **升快降慢**：升是即時的、降要低水位持續一小時——不對稱是刻意的，防止水位在門檻附近抖動導致機器上上下下
- **讀不到現場就不動作**：房間數或雲平臺真值任一讀不到，調節器一律跳過。寧可不升，不瞎動
- **活動檔期間 R1/R2 全部停用**：人已鎖定，機器不搶方向盤
- **每次換檔寫監控事件**：調節器的每一步在監控中台可見、可稽核

### 2.4 接線點（只有三個，零碰語音 agent 本體）

1. **token 發放 API**：發完 token 後，**用平臺的「回應後執行」機制**（Next.js 是 `after()`）呼叫升檔檢查
   ⚠️ 實踩雷：serverless 上回應一送出 lambda 就凍結，`void promise` 的背景工作會無聲蒸發（零錯誤、看起來像跑了）。凡是「回應後才要完成」的工作必須走官方 after/waitUntil 機制
2. **既有的閒置巡檢 cron**（本來就要有，見 2.5）：順路跑 R2＋R3
3. **admin 電源開關 API**：開機時跑 R4

### 2.5 依賴的前置設施（沒有就先蓋這些）

- **電源兩層開關**：功能旗標（DB boolean，token API 每次讀，關=秒級擋新通話）＋費用層（min-instances）。永遠先切旗標再動實例——旗標是真相，實例只是錢
- **自動關機**：發 token 時戳 `lastCallAt`；cron 30 分/輪，閒置超過門檻（我們 3 小時）→ 關旗標＋min=0
- **自動開機不要做「來電喚醒」**：冷啟動 30-60 秒，用戶等不了。排程開機＋手動開機就好
- **部署腳本不寫 min-instances**：寫死=殭屍復活術，下次部署把調節器的決定無聲洗回。deploy 不帶此旗標＝保留線上現值

### 2.6 Admin API 契約

```
GET  /api/admin/voice-capacity
  → { powerOn, gear:'off'|'standby'|'event', desiredMin,
      cloudRunMin, cloudRunMax,          # 雲平臺真值（驗證看這兩個）
      eventMode|null, rooms, capacity, perInstance, lowWaterSince }

POST /api/admin/voice-capacity
  { action:'event', min:3, hours:2 }     # 進活動檔（hours clamp 0.5..24）
  { action:'standby' }                   # 手動退回待命 min=1
```

UI 最小集：目前檔位＋台數＋「房間/容量」水位、一顆「進活動檔（MAX 台 · 2 小時）」按鈕＋倒數、活動中顯示「提前退」。

---

## 第三章 常數怎麼定（遊戲規則）

所有常數從**一個實測數字**推導：單台幾路（第五章方法論）。我們的值（2 CPU / 2GB / 台）：

| 常數 | 我們的值 | 推導 |
|---|---|---|
| 每台安全路數 | **5** | 實測穩態 6 路無劣化 → 留一路餘裕 |
| MAX（成本保險絲） | **3** | ⌈目標尖峰併發 15 路 ÷ 5⌉ |
| 升檔水位 | **70%** | 待命 1 台時=第 4 路進來即暖第 2 台，暖機時間剛好蓋住第 5-6 路 |
| 降檔水位＋持續 | **40% ＋ 60 分** | 低於下一檔容量的一半才考慮縮，持續一小時防抖 |
| 進線斜率上限（建議加做） | 3 通/15 秒/台 | 實測建線爆發資料（第四章） |

**你們的值必須自己測**——機型、STT/TTS 供應商、agent 框架都會改變單台路數。方法照第五章，半天。

---

## 第四章 實測數據（AILiveX 2026-07-11，校準參考）

### 4.1 階梯結果（單台 2 CPU / 2GB，208 有效回合）

| 併發 | 回合 | 回合延遲 p50 | p95 | max | 逾時 | 拒接 | 卡頓 |
|---|---|---|---|---|---|---|---|
| 1 | 10 | 4094ms | 9725ms* | 9725ms | 0 | 0 | 0 |
| 2 | 20 | 3853ms | 5843ms | 5843ms | 0 | 0 | 0 |
| 3 | 30 | 3886ms | 5958ms | 10806ms | 0 | 0 | 0 |
| 4 | 40 | 4015ms | 4959ms | 5090ms | 0 | 0 | 0 |
| 5 | 50 | 3874ms | 5808ms | 9045ms | 0 | 0 | 0 |
| 6 | 58 | 4351ms | **26784ms** | 27562ms | 1 | 0 | 0 |

\* 首階樣本少＋首回合含記憶載入。CPU（p99）：全程 9%→66%，未飽和。

### 4.2 三個判讀

1. **穩態容量 6 路**：p50 從 1 路到 6 路幾乎不動（3.9-4.4s）、零卡頓零拒接、CPU 66% → 外推天花板 8-9 路，安全閘取 5
2. **第 6 階 p95 暴衝的真相**：災難全部集中在階梯開場 15 秒——6 通近乎同時建線，5 通的首兩回合 23-27.5 秒＋1 通逾時；建完線後穩態回落 4-7 秒。**這就是「同時建線爆發」**，容量規劃的真敵人
3. **開場白延遲恆定 8.3 秒**（dispatch→agent 第一聲），與併發無關——是固定成本（載靈魂/記憶＋首輪），屬獨立 UX 優化題，不影響容量常數

### 4.3 上線後的實彈驗證（變速箱）

42 秒完整一輪，每步讀雲平臺真值（不是讀自己的 doc）：
關機基線 min=0 → 開機 min=1 → 進活動檔 **min=3（真值，實例真的在暖）** → 退待命 min=1 → 關機 min=0 ✓，調節器事件兩筆全留痕。

---

## 第五章 負載實測方法論（怎麼模擬真實用戶）

> 核心思想：**造一批「合成來電者」打真電話**——真 STT、真 LLM、真 TTS、真記憶載入，一路一路加，量「用戶講完到角色開口」的延遲曲線。曲線膝蓋彎起的那一路＝單台容量。成本：半天工＋幾美金。

### 5.1 隔離三件套（先做，不做會污染生產）

1. **測試服務隔離**：部署一台跟生產**一字不差**的 agent——複製啟動入口、只改 `agent_name`（如 `xxx-realtime-loadtest`）＋獨立服務名，`min=1/max=1` 鎖單台。共用 WebRTC 雲時靠 agent_name 派工隔離，生產流量零污染
2. **測試身份隔離**：建專屬測試 user＋測試角色。**agent 會把合成通話當真的處理**——我們的 agent 從假通話裡抽了 14 筆「記憶」寫進 DB，若掛在真角色下就污染真人格。測試角色的靈魂設成「一律一兩句話短回應」（延遲量的是開口速度，回應短=省錢+單位時間更多樣本）
3. **測後清理清單**：對齊 agent 會寫的每一個 collection（記憶/對話/關係/日記/用量），測完全刪＋刪測試服務＋**隔日拉計費指標確認歸零**（設定畫面說了不算）

### 5.2 合成來電者（單隻的解剖）

```
每隻來電者（獨立房間，模擬 1:1 通話）：
1. 本機用 API key 直接 mint 房間 token（不走平臺登入）
2. 進房、發布音軌
3. explicit dispatch 指名叫測試 agent 進房（CreateAgentDispatchRequest{agent_name, room, metadata}）
   metadata 帶生產同款欄位（characterId/userId/convId...），agent 走完全真實路徑
4. 等 agent 開場白（首次出聲）→ 記 greet 延遲；20 秒沒聲=「拒接」（worker 滿載信號）
5. 回合迴圈：
   a. 播預錄語音 WAV（真人問句，我們用 OS 內建 TTS 生成 4 秒中文問句，48kHz mono）
   b. 尾端補 600ms 靜音（讓 agent 的 VAD 斷句）→ 記 utterance_end 時刻
   c. 監聽 agent 音軌：對每幀算 RMS 能量，首次越過門檻（int16 RMS > 700）
      = agent 開口 → turn_latency = 開口時刻 − utterance_end
   d. 30 秒沒開口=「逾時」
   e. 等 agent 講完（能量低於門檻持續 1.5s）→ 停 1s → 下一回合
6. 同時記「卡頓」：agent 說話中，音訊幀到達間隔 > 250ms 的次數（破音 proxy）
```

**三個量測定義（照抄）：**
- `turn_latency`＝我方語音（含尾端靜音）送完 → agent 回聲能量首幀。這是用戶唯一感受得到的數字
- `stutter`＝說話中幀距 > 250ms 次數。穩態劣化的早期信號
- `no_agent`＝dispatch 後 20s 無聲。worker 滿載拒接的信號

### 5.3 階梯協議

```
for 併發 in [1, 2, 3, 4, 5, 6, ...]:
    起 併發 隻來電者（各自獨立房間，錯開 3 秒起跑）
    跑滿 180 秒（或每隻最多 10 回合）
    全部掛斷 → 記錄本階 p50/p95/逾時/拒接/卡頓 → 停 5 秒 → 下一階
輸出 JSONL（每回合一行）＋每階摘要
```

- **錯開 3 秒**：注意這仍會觸發建線爆發（我們第 6 階就是這樣發現的）——這是 feature 不是 bug，它同時測出了穩態容量和進線斜率上限兩個數字
- 同步抓雲平臺 CPU 指標（3 分鐘對齊），事後對照
- **判讀**：p95 曲線膝蓋＝容量；膝蓋那一階再看延遲分佈——若尾部全集中在開場（首兩回合），瓶頸是建線斜率不是穩態併發，兩個結論分開記

### 5.4 踩過的雷（你們大概率也會踩）

1. **跑壓測的機器要放雲端**：我們本機到 WebRTC edge 的 TCP 被 ISP 路由擋死（Google 通、官網通、edge 超時）。來電者放同區域一台臨時小 VM（$0.07/hr，測完刪）。順帶：用戶回報「連不上」先讓他換網路排除這條
2. **nohup 長跑腳本 stdout 會緩衝**：進度真相設計成直寫資料檔（JSONL append），別 tail log
3. **驗管道先 smoke**：正式階梯前先跑 1 路 1 回合，驗「token→進房→dispatch→agent 接→聽懂→回聲→量到延遲」整條通
4. **絕不壓生產服務**：上市前夕尤其。隔離服務多花半天，值得

---

## 第六章 AI 機讀規格（給協助施工的 AI 直接吃）

```yaml
elastic_voice_capacity_spec:
  version: 1.0
  proven_on: "AILiveX (LiveKit + Cloud Run + Firestore), live-fire verified 2026-07-11"

  physics:
    - "agent at min=0 is DEAF (dispatch undeliverable), not slow -> floor is 1 while open"
    - "capacity killer = simultaneous call SETUP (CPU spike), not concurrent talking (measured)"
    - "native autoscaler is lagging; regulator watches rooms/capacity (leading)"

  state_machine:
    gears:
      off:     { min: 0, flag: false }
      standby: { min: "1..MAX, regulator-controlled" }
      event:   { min: "MAX, time-locked", invariant: "MUST auto-revert on expiry via cron" }
    transitions:
      power_on:  "off->standby, ALWAYS reset desiredMin=1, clear eventMode"
      auto_off:  "standby->off when idle>3h (cron, lastCallAt touched at token issue)"
      event_in:  "admin action {min, hours(0.5..24)}"
      event_out: "cron on expiry OR manual"

  data_model:
    config/voiceCapacity:
      desiredMin: "int, regulator intent (1..MAX)"
      eventMode: "{min, until:ISO} | null"
      lowWaterSince: "ISO | null  # scale-down observation window"
    truth_hierarchy: "cloud platform API minInstanceCount is TRUTH; desiredMin is intent; verify against truth only"

  regulator_rules:
    R1_scale_up:
      trigger: "token issuance (post-response async — use platform after()/waitUntil, NEVER bare void promise on serverless)"
      condition: "(active_rooms + 1) >= capacity * 0.70"
      action: "desiredMin+1 (<=MAX) via DB transaction (serialize concurrent bumps), then PATCH cloud"
    R2_scale_down:
      trigger: "cron every 30min"
      condition: "rooms < capacity * 0.40 sustained >= 60min (lowWaterSince window)"
      action: "desiredMin-1 (floor 1), PATCH"
    R3_event_expiry: { trigger: "same cron", action: "clear eventMode, min=1, PATCH" }
    R4_power_on_reset: { trigger: "admin power on", action: "desiredMin=1, clear all" }
    capacity_formula: "max(desiredMin, cloud_truth_min) * SAFE_ROOMS_PER_INSTANCE"
    fail_safe: "any live read (rooms / cloud scaling) fails -> DO NOTHING this round"
    event_lock: "R1/R2 disabled while eventMode active"
    observability: "every gear change -> monitoring event (action, min, rooms)"

  constants_derivation:
    source: "ONE measured number: steady-state rooms per instance (see loadtest_methodology)"
    ours: { instance: "2 CPU / 2GB", steady_ok: 6, safe_gate: 5, max_instances: 3,
            up_at: 0.70, down_at: 0.40, down_hold_min: 60 }
    warning: "DO NOT copy 5/instance — measure your own; stack differences change it"

  prerequisites:
    - "two-layer power switch: DB flag (truth, instant, token API checks every call) + min-instances (money)"
    - "auto-off cron + lastCallAt touch; NO wake-on-call (cold start 30-60s = churn); scheduled/manual on"
    - "deploy script MUST NOT set min-instances (else next deploy silently reverts regulator)"

  measured_data_2026_07_11:
    ladder: # concurrency: [turns, p50_ms, p95_ms, timeouts]
      1: [10, 4094, 9725, 0]
      2: [20, 3853, 5843, 0]
      3: [30, 3886, 5958, 0]
      4: [40, 4015, 4959, 0]
      5: [50, 3874, 5808, 0]
      6: [58, 4351, 26784, 1]   # tail = SETUP BURST at rung start, steady-state fine
    cpu_p99_at_6_rooms: 0.66
    greeting_fixed_cost_s: 8.3   # dispatch->first audio, load-independent
    setup_burst: "6 calls in 15s window -> first turns 23-27.5s; steady later turns 4-7s"
    implied_rate_gate: "3 new call-setups / 15s / instance (recommended admission control)"

  loadtest_methodology:
    isolation:
      - "clone agent entry, change ONLY agent_name + service name, min=1/max=1 (pin single instance)"
      - "dedicated test user + test character (agent WILL write real memories from fake calls — 14 docs in our run)"
      - "test character soul: 'reply in 1-2 short sentences' (latency measures onset, short = cheap + more samples)"
      - "cleanup script covering every collection agent writes; verify via billing meter next day, not config screen"
    synthetic_caller:
      token: "mint locally with API key/secret, skip platform login"
      dispatch: "explicit CreateAgentDispatchRequest{agent_name, room, metadata=production-shaped}"
      speak: "prerecorded 4s speech WAV (OS TTS fine), 48kHz mono, +600ms tail silence for VAD endpointing"
      detect: "subscribe agent audio; per-frame int16 RMS; onset = RMS>700 after utterance_end"
      metrics:
        turn_latency_ms: "utterance(+silence) sent -> first loud agent frame  # THE user-felt number"
        stutter: "frame arrival gap >250ms while agent speaking"
        no_agent: "20s silence after dispatch = worker saturated/refusing"
        timeout: "30s no onset after utterance"
    ladder_protocol: "rungs 1..N concurrent callers (separate rooms), stagger 3s, 180s or 10 turns per rung, 5s gap; JSONL per turn; pull cloud CPU aligned 3min"
    reading_results:
      capacity: "p95 knee rung"
      burst_vs_steady: "if knee-rung tail concentrates in first 1-2 turns per caller -> bottleneck is setup RATE, record both numbers separately"
    pitfalls:
      - "run callers from a cloud VM in-region: local ISP may black-hole WebRTC edge IPs (we hit this: google OK, edge TCP timeout)"
      - "nohup buffers stdout: write progress as JSONL appends, don't trust run.log"
      - "smoke test 1 caller x 1 turn end-to-end before the ladder"
      - "never load-test the production service"

  verification_protocol:  # 宣告「做好了」之前，指出只有做好才會出現的信號
    - "event mode POST -> cloud API truth shows min=MAX (not your own doc)"
    - "standby POST -> truth min=1; power off -> truth min=0"
    - "regulator events present in monitoring store"
    - "cost-off claim -> billable_instance_time meter reaches zero, config screen is zero-information"
```

### 移植最快路徑（順序即依賴）

1. 兩層電源開關＋自動關機（2.5 前置）→ 2. 負載實測拿「單台幾路」（第五章，半天）→ 3. 從那個數字推所有常數（第三章）→ 4. `voice-capacity` 模組＋三接線點（2.3/2.4）→ 5. admin API＋一顆活動檔按鈕（2.6）→ 6. 實彈驗證一輪（verification_protocol）→ 7. （建議加碼）token API 併發總量閘＋進線斜率閘

---

*規格與數據來自 AILiveX 生產系統。設計可移植；常數不可移植，請照第五章自測。*
