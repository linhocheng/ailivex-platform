# 即時語音平臺防爆白皮書
## ——同時湧入不爆炸、CPU 加開規則、自動開關設計

**版本**：v1.0（2026-07-11）
**作者**：築（AILiveX 平臺監造）
**對象**：準備建構即時語音的團隊（假設你們從零開始），以及協助你們施工的 AI
**依據**：AILiveX 生產系統（LiveKit + Cloud Run + Firestore）＋ 2026-07-11 負載實測真數據，不是理論推演

> **給協助施工的 AI**：本文第六章是為你準備的速讀區——關鍵數字、不變量、決策規則的結構化摘要。人類讀者請從第一章開始。

---

## 第〇章 這套系統的形狀（一頁看懂）

```
用戶瀏覽器
   │  POST /api/livekit/token        ←←← 全系統唯一撥號入口（咽喉）
   ▼
[平臺後端（serverless）]
   ├─ 閘 1：電源旗標（DB 一個 boolean）
   ├─ 閘 2：用戶額度（剩餘語音秒數）
   ├─ 閘 3：併發總量（現役房間數 vs 容量）
   └─ 發 JWT ＋ 指定派工對象（agent_name）
   ▼
[LiveKit Cloud（WebRTC 房間）]──派工──▶ [語音 agent（Cloud Run 常駐容器）]
                                            │ 每通電話一條鏈：
                                            │ STT（語音辨識）→ LLM（生成）→ TTS（合成）
                                            ▼
                                        [Firestore 記憶庫]
                                        每筆記憶綁 (userId × characterId)
```

三個角色分工，記死這個就懂一半：

| 元件 | 性質 | 爆炸方式 |
|---|---|---|
| 平臺後端（Vercel/serverless） | 彈性層，一請求一實例 | **不會爆，只會計費** |
| 語音 agent（Cloud Run） | **固定容量層**，一台撐 N 路 | 人多了大家一起變卡 |
| 記憶庫（Firestore） | 彈性層 | 不會爆，但設計錯會又慢又貴 |

**所以「防爆」的主戰場只有一個：語音 agent 這個固定容量層。**

---

## 第一章 為什麼即時語音會爆：三條物理定律

### 定律一：語音 agent 睡著＝聾，不是慢

一般網頁服務縮到 0 台，下一個請求會冷啟動——慢幾秒但能用。
**即時語音 agent 不是這樣。** 它是「常駐連線、主動領工」的模式（LiveKit worker 向雲端註冊待命）：縮到 0 台，派工**根本送不到**，用戶按下通話鍵後永遠等不到人接——不是慢，是聾。

推論：你永遠需要至少 1 台醒著待命，這台的月費（我們實測約 $60/月級）買的是「下一秒有人打進來接得起」。這筆錢省不掉，但可以用自動開關把「沒人的時段」的錢省掉（第四章）。

### 定律二：爆炸三部曲——延遲爬升 → 排隊 → 錯誤

固定容量層過載不會立刻報錯。順序是：回應延遲先悄悄變長 → 內部排隊 → 最後才出現逾時/錯誤。**只監控錯誤等於只看到第三幕**，觀眾（用戶）在第一幕就開始難受了。監控要看的是延遲曲線和水位（目前併發 / 容量上限），不是只看錯誤率。

### 定律三（最重要，實測才知道）：真短板是「同時打進來」，不是「同時講」

我們用合成來電者做了階梯實測（1→6 路併發、每階 3 分鐘、208 個回合），結果顛覆直覺：

| 併發路數 | 回合延遲 p50 | p95 | 卡頓 | 拒接 |
|---|---|---|---|---|
| 1～5 路 | 3.9～4.4s（平穩） | 5～6s | 0 | 0 |
| 6 路 | 4.4s（穩態仍正常） | **26.8s** | 0 | 0＋1 逾時 |

第 6 階的災難**全部集中在開場 15 秒**：6 通電話近乎同時建線，其中 5 通的頭兩個回合飆到 23～27 秒。一旦建完線，穩態馬上回落正常。

原因：**每通新電話的建線是 CPU 尖刺**（開子行程＋載入角色與記憶＋首輪推理），穩態通話反而便宜。所以：

> **6 個人「同時在講」沒事；6 個人「同一秒打進來」會讓所有人的第一句話等 27 秒——用戶等 27 秒早就掛了。**

這條用沙盤推演推不出來，必須實測。你們的系統數字會不同，但**現象必然存在**。

---

## 第二章 同時湧入不爆炸：五道閘 ＋ 記憶庫三原則

### 五道閘（按請求路徑順序，全部釘在撥號咽喉上）

所有閘都設在**發 token 的那一個 API**上。這是天條：**防禦釘在收斂點，不是每個生產端**。撥號入口只有一個，擋住這裡＝物理上不可能超載，跟雲端有幾台實例殘留無關。

**閘 1：電源旗標**——DB 裡一個 boolean（`config/voicePower.on`）。關閉時一律拒發 token（連管理員也擋，避免測試假象）。這是秒級生效、零殘尾的總開關，也是自動關機的執行點。

**閘 2：用戶額度**——每個用戶有語音總秒數上限，發 token 前查（用 DB transaction 讀，防止並發重複扣）。通話中 agent 每 30 秒回寫用量、到點主動斷線。

**閘 3：併發總量閘**——發 token 前數現役房間數，≥ 台數 × 5（見第三章的 5 怎麼來）就回「目前忙線」。**讓第 N+1 個人在門口被禮貌拒絕，好過讓 N 個人一起破音。**

**閘 4：進線斜率閘**（定律三的直接對策）——單台 15 秒窗口內最多接 3 通新建線，超過的排隊 5～10 秒再放行（前端顯示「正在接通」）。總量閘管「多少人在線」，斜率閘管「多快進來」，**兩個都要有**。

**閘 5：成本保險絲**——Cloud Run `max-instances`。自動擴容永遠不會超過它，這是「湧入變成帳單災難」的最後一道保險。

### 記憶庫三原則（用戶端記憶資料庫怎麼不被湧入拖垮）

記憶庫（Firestore 這類 serverless NoSQL）本身不會被打爆，但設計錯了會在湧入時**又慢又貴**，並拖慢每通電話的建線（正好踩中定律三）。三原則：

**原則一：分片綁定，讀路徑 O(自己) 不是 O(全部)。**
每筆記憶必須綁 `(userId × characterId)` 複合鍵。100 個用戶同時上線＝100 條互不重疊的讀取路徑，天然水平擴散。反例是「全域記憶表撈出來再過濾」——10 人時沒感覺，100 人時建線時間翻倍。

**原則二：寫路徑全部後置，永不擋住回應。**
記憶抽取、關係計數、日記——所有通話後的寫入放在「回應送出之後」的非同步區（掛斷後的收尾窗口）。用戶感受到的延遲裡**不允許包含任何記憶寫入**。代價是這些寫入失敗會無聲丟失——所以每次寫失敗要留事件（我們 Phase 2 的監控管道），但**絕不因此把它搬回同步路徑**。

**原則三：帳務類寫入用 transaction，其他用 best-effort。**
額度扣減這種「多扣一次就是錢」的寫入，一律 DB transaction 原子化（查與扣同一筆交易）。記憶、日記這種「丟一筆不致命」的，best-effort 就好。**分清楚哪些寫入是帳、哪些是筆記**，帳用機制保證，筆記允許丟。

---

## 第三章 多少人要加開 CPU？遊戲規則

### 第一步：先實測「單台幾路」，沒有這個數字一切都是猜

方法（照抄即可，半天工＋幾美金）：

1. 部署一台**跟生產一字不差**的測試服務，鎖 min=1/max=1（單台隔離）
2. 寫合成來電者：進房、播一段預錄語音、偵測 agent 回聲首幀，量「講完→開口」的回合延遲
3. 階梯上壓：1 路、2 路、3 路……每階 3 分鐘，記 p50/p95
4. **p95 曲線膝蓋彎起來的那一路，就是單台真實容量**
5. 測試流量必須掛在專屬測試帳號下（agent 會把合成通話當真的寫記憶！），測完清資料、刪服務、隔天看計費錶歸零

我們的結果（2 CPU / 2GB / 一台）：穩態 6 路無劣化、CPU 66%，**取保守值 5 路/台當閘值**。你們的數字照自己實測為準。

### 第二步：三個水位規則（訂了就不用再開會）

以「目前併發 ÷ 目前容量」為唯一指標（容量＝醒著的台數 × 5）：

| 水位 | 動作 |
|---|---|
| ≥ 70%（黃） | min-instances +1（預熱下一台） |
| ≥ 90%（紅） | 前端顯示忙線提示，斜率閘收緊 |
| < 40% 持續兩個檢查週期（約 1 小時） | min-instances −1，直到回到 1 |

**升檔觸發點放在發 token 的瞬間**（有人要打電話＝領先指標，新台在通話建立前就開始暖機）；**降檔放在定時巡檢**（升快降慢，避免上下抖動）。

### 第三步：變速箱三檔（人只管換檔，台數機器管）

| 檔位 | 設定 | 何時 |
|---|---|---|
| 關機 | min=0＋電源旗標關 | 深夜／無客戶時段（自動，見第四章） |
| 待命 | min=1，水位規則自動 1↔max | 平常營業 |
| 活動 | min=3 起跳，**限時後自動降回** | 發表會／行銷檔期，後台一顆按鈕 |

**公式收尾**：`max-instances = ⌈目標尖峰併發 ÷ 5⌉`。要撐 20 路尖峰 → max=4。注意：20 個「在線用戶」≠ 20 路「同時通話」，語音併發通常是同時在線人數的 1/3～1/5，用自己的真實數據校正。

---

## 第四章 自動關閉與自動開啟

### 核心設計：兩層開關，缺一不可

**功能層（旗標）**：DB 一個 boolean，發 token 的 API 每次都讀。關＝秒級擋住所有新通話，與雲端實例狀態完全無關。
**費用層（實例）**：Cloud Run min-instances 0↔1。這層慢（切換有殘尾），所以**永遠先切旗標、再動實例**。

為什麼要兩層？因為雲端實例的關閉有殘尾（見下方雷區），如果只靠實例層，「按了關」和「真的不再接通話」之間有幾分鐘的模糊地帶。旗標層把這個模糊地帶消滅成零——**旗標是真相，實例只是錢**。

### 自動關機（三件套）

1. 每次成功發 token 時，戳一下 `lastCallAt` 時間戳（一行代碼，fire-and-forget）
2. 排程任務每 30 分鐘檢查：`now - lastCallAt > 閒置門檻（我們用 3 小時）` → 關旗標＋降 min=0
3. 後台顯示目前開關狀態＋最後通話時間，人可隨時手動覆寫

### 自動開機的誠實答案：不要做「來電喚醒」

冷啟動要 30 秒～1 分鐘（容器啟動＋模型載入），用戶按下通話鍵等一分鐘＝流失。所以自動「開」不是被動喚醒，而是**排程開機**（營業時間前自動開）＋**手動開機**（後台一鍵）。「有人想打就自己醒」在即時語音是偽需求，別浪費時間做。

### 這一章的三個天條（我們付過學費的）

1. **手動改了雲端資源，同一個工作日改部署腳本。** 部署腳本裡寫死的 `--min-instances=1` 是殭屍復活術：你手動降 0 省的錢，下次部署會被無聲洗回來。正確做法：部署腳本**不帶** min-instances 旗標（保留線上現值），或跟開關系統讀同一個來源。
2. **驗證「不燒錢了」看計費錶，不看設定畫面。** 設定面、實例面、計費面是三件事：流量若釘在舊版本，服務設定寫 0、舊版本照燒；每次設定變更還會生出一顆最長活 15 分鐘的驗證實例。收案標準只有一個：計費指標（billable_instance_time）歸零。
3. **常駐必配開關＋自動關機。** 判準一句話：這台機器閒著時，有沒有人可能下一秒需要它？有（營業中的即時語音）→ 常駐＋本章機制；沒有（批次任務、文件生成）→ 根本不要常駐，用 Cloud Run Jobs 這類跑完即滅的形態。

---

## 第五章 雷區清單（每一條都是真實事故）

按「你們會遇到的順序」排：

1. **共用 LiveKit project 必用 agent_name 隔離。** 兩個業務（或生產＋測試）共用同一個 LiveKit 時，靠 prompt 防呆會串台；必須各自註冊不同 `agent_name`，派工時明確指名。我們的負載測試服務就是同一份代碼、只換 agent_name，生產流量零污染。
2. **LiveKit Agents 1.5.x 的 token 必帶 RoomConfiguration。** 1.5.x 預設 explicit dispatch，照舊版文件只發 token 不帶派工設定 → agent 永遠不進房，而且**無聲失敗**（沒有任何錯誤）。
3. **依賴版本釘死。** 我們把 LiveKit plugins 釘在 `==1.5.1`——版本飄移曾直接讓串流 crash。即時語音的依賴鏈（STT/TTS SDK）全部釘版本，升級走隔離的新版本服務。
4. **「沒聲音」先查殭屍實例。** 同一個 agent_name 部到兩個 region、各自 min=1 → 派工被偷走一半，症狀是「一半的通話沒聲音」。用不帶 region 的全域列表掃。
5. **部分 ISP 到 LiveKit edge 的路由會不通。** 我們親測：同一台機器 Google 通、LiveKit 官網通，唯獨到 LiveKit edge IP 的 TCP 超時。用戶回報「連不上」時，先讓他換網路（手機熱點）排除這條，別急著查自己的服務。
6. **有 CPU throttle 的 serverless 上不存在 fire-and-forget。** 回應送出後 CPU 會被掐掉，「回應後繼續算」必死。長任務（記憶鞏固、文件生成）進獨立的 Job 形態，即時語音 agent 必須 `no-cpu-throttling`。
7. **判斷用小模型或代碼，開口用大模型，但 go/no-go 永遠是確定性代碼。** 該不該接話、防抖、冷卻——這些用代碼寫死；LLM 只負責打分和生成。把時序控制丟給 LLM 是用機率引擎做計算工作，遲早翻車。
8. **模稜兩可的信號不能當成功證據。** timeout／沉默／連線錯誤，成功和失敗都相容＝零資訊。宣告「修好了」之前，先寫下「只有修好才會出現的信號」（目標狀態進了 DB、log 出現完成行），再去看。
9. **監控燈號只從證據亮。** 綠＝近期有成功呼叫的證據；沒流量＝灰燈誠實說「不知道」，不從「設定看起來對」推綠燈。假中台（燈是綠的、管道是斷的）比沒有監控更危險。
10. **雲端金鑰用平臺身份（ADC），不要注入金鑰檔。** 在 Cloud Run 上注入 service account JSON 走外部 token 交換，某些環境會神祕地斷（`Premature close`）；用平臺原生的身份機制（metadata server）永遠可達。

---

## 第六章 給 AI 的速讀區（machine-readable）

```yaml
system_shape:
  choke_point: "POST /api/livekit/token — 唯一撥號入口，所有閘釘這裡"
  fixed_capacity_layer: "voice agent (Cloud Run, min-instances>=1 常駐)"
  elastic_layers: ["platform backend (serverless)", "memory DB (Firestore)"]

physics:
  - "agent min=0 == deaf (dispatch 送不到), not slow"
  - "overload sequence: latency_creep -> queueing -> errors (monitor leading indicators)"
  - "bottleneck == simultaneous CALL SETUP, not concurrent talking (measured)"

measured_numbers:  # AILiveX 2026-07-11, 2 CPU / 2GB per instance
  steady_state_capacity: 6   # rooms/instance, no degradation, CPU 66%
  safe_gate: 5               # rooms/instance (conservative)
  setup_burst_limit: "3 new calls / 15s / instance"
  setup_burst_violation: "first-turn latency 4s -> 23-27s"
  greeting_fixed_cost: "8.3s dispatch->first-audio, independent of load"
  note: "你的系統要自己重測，方法在第三章；現象通用、數字不通用"

gates_in_order:  # all at token endpoint
  1: {name: power_flag, impl: "DB boolean, deny all incl. admin when off"}
  2: {name: user_quota, impl: "transactional read; agent meters +30s heartbeat"}
  3: {name: concurrency_cap, impl: "active_rooms >= instances*5 -> busy"}
  4: {name: setup_rate_limit, impl: "max 3 new calls/15s/instance, else queue 5-10s"}
  5: {name: cost_fuse, impl: "cloud max-instances = ceil(target_peak/5)"}

memory_db_rules:
  - "every record keyed (userId x characterId); reads O(own), never O(all)"
  - "all post-call writes async after response; user latency contains zero memory writes"
  - "money-writes (quota) = transactions; note-writes (memories/diary) = best-effort"

scaling_rules:
  metric: "active_rooms / (awake_instances * 5)"
  scale_up: {at: 0.70, action: "min_instances += 1", trigger: "on token issuance (leading)"}
  alert: {at: 0.90, action: "frontend busy notice + tighten rate gate"}
  scale_down: {at: "<0.40 for 2 cycles (~1h)", action: "min_instances -= 1, floor 1", trigger: "cron"}
  gears: {off: "min=0 + flag off", standby: "min=1 auto", event: "min=3 timed, auto-revert"}

auto_off_on:
  design: "two layers: flag (truth, instant) + min-instances (money, slow); flag first always"
  auto_off: "touch lastCallAt on token issue; cron 30min; idle>3h -> flag off + min=0"
  auto_on: "scheduled/manual only; wake-on-call is anti-pattern (cold start 30-60s = churn)"

hard_rules:  # 天條
  - "manual cloud change -> update deploy script SAME DAY (zombie revival)"
  - "verify cost-off via billing meter, never config screen"
  - "standing cost only for second-level readiness; batch work -> Jobs"
  - "separate agent_name per service/env sharing one LiveKit project"
  - "LiveKit 1.5.x token MUST carry RoomConfiguration (silent failure)"
  - "pin all realtime dependency versions; upgrade = new isolated service"
  - "go/no-go timing decisions in deterministic code, LLM only scores/drafts"
  - "ambiguous signals (timeout/silence) are zero-information, never success proof"
  - "monitor lights from evidence only; no-traffic = gray, never green"
```

### 最快路徑（從零到上線的順序）

1. 先跑通 1 路：token 咽喉 → LiveKit → agent → STT/LLM/TTS 一條鏈（一吋蛋糕：能打通一通電話再談其他）
2. 加閘 1（電源旗標）＋閘 2（額度）——上線第一天就要有
3. 負載實測拿到「單台幾路」（第三章方法，半天）
4. 加閘 3（總量）＋閘 4（斜率）＋設 max-instances（閘 5）
5. 自動關機三件套（第四章）
6. 監控面板：水位計＋燈號（從證據亮）＋失敗事件表
7. 對照第五章雷區清單逐條自查

---

*本白皮書所有數字來自 AILiveX 生產系統實測（loadtest harness 與原始數據在 repo `loadtest/`）。方法可移植，數字請自測。*
