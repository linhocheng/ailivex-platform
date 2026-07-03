# 角色記憶系統白皮書 v1.0

> 目的：把 ailiveX 已驗證的「角色記憶系統」移植到 ailive-platform。
> 讀者：接手的工程師。本文是設計規範＋踩雷紀錄，參考實作全在 ailivex-platform repo。
> 日期：2026-07-03 ｜ 現況：本設計已在 ailiveX 上線（文字＋語音雙路徑，v15）

---

## 0. 一句話說明這個系統

每個「用戶 × 角色」配對有自己私有的記憶庫：同一個角色對不同的人記得不同的事。
對話結束後自動萃取記憶，下次對話時依「當下在聊什麼」檢索注入，讓角色像個記得你的老朋友。

## 1. 三條不可違背的設計原則

1. **記憶嚴格綁定 `(userId, characterId)`**——查詢、寫入、去重全部帶這兩個條件，永不跨用戶。
2. **確定性的工作用程式，不丟 LLM**——計數、去重、排序、生命週期、節流全是程式；LLM 只做兩件事：萃取（判斷什麼值得記）與 resolved 判定（判斷哪些問題已被回答）。LLM 的輸出一律當不可信文字，程式 parse／validate。
3. **文字與語音兩條路徑必須是鏡像**——這是 ailiveX 踩過最大的坑（曾累積 15 項不一致，語音記憶淪為二等公民）。任何改動：改一邊，必改另一邊，否則就是沒改。

## 2. 資料模型（Firestore `memories` collection）

```
{
  userId, characterId          // 綁定鍵，所有查詢必帶
  content: string              // 記憶本文（繁中，平均 60-130 字）
  type: 'fact' | 'emotion' | 'preference' | 'promise' | 'question' | 'milestone'
  tier: 'fresh' | 'core' | 'archive'    // 生命週期層
  status: 'active' | 'stale' | 'resolved'  // 與 tier 是不同軸，勿混用
  importance: 1-10             // 萃取時由 LLM 判定，clamp 到範圍
  hitCount: number             // 被檢索命中次數（晉升依據）
  lastHitAt: Timestamp | null
  embedding: number[768]       // Vertex text-embedding-004，寫入時生成
  source: 'extraction' | 'voice' | 'tool:remember'
  createdAt: Timestamp
}
```

六種 type 的萃取語式（prompt 裡固定）：
fact「用戶…」／emotion「談到XXX時，感覺…」／preference「用戶偏好…」／
promise「我答應了…」／question「用戶還在考慮…」／milestone「用戶…（重要轉折）」

**⚠️ 每個欄位都要有寫入者。** ailiveX 曾經 status 全庫為空（stale 機制整個死掉）、
語音寫的記憶缺 embedding（文字檢索永遠碰不到）。移植時逐欄位確認「誰寫、誰讀」。

## 3. 寫路徑（對話後萃取）

流程：`對話結束 → LLM 萃取候選 → 每條候選：生 embedding → 雙門檻去重 → 寫入`

- **萃取**：Haiku（成本考量），餵最近 20 條訊息，輸出 `<result>[{content, type, importance}]</result>`
  JSON。type 不在白名單 fallback 成 fact；importance clamp 1-10。
- **embedding**：Vertex `text-embedding-004`，768 維。**寫入前驗維度**（維度漂移會讓檢索靜默失準）。
  生成失敗照樣寫入（寧缺向量不丟記憶），之後補。
- **去重（最重要的踩雷紀錄）**：判定重複必須**雙門檻同時成立**：
  ```
  cosine(新, 舊) >= 0.9  AND  CJK-bigram重疊率(新, 舊) >= 0.5，且只跟同 type 比
  ```
  為什麼：純 cosine 會大誤殺。實測 0.85 純 cosine 把「牧羊人的奇幻之旅」「咖啡館手沖」等
  完全不同的事件判成重複（同一對人的長篇敘事記憶，embedding 天生擠在一起）；
  升到 0.92＋同型**仍然誤殺**。真重複的特徵是**逐字級相似**，所以詞彙重疊是必要條件。
  bigram 重疊率 = 兩段文字的 CJK 二字組交集 ÷ 較短者的二字組數。
- **resolved 判定**：萃取的同一次 LLM 呼叫，附上該配對目前 active 的 question 清單（編號），
  要求輸出 `<resolved>[編號]</resolved>`；程式做編號→docId 映射後標 `status:'resolved'`。
  沒有這個機制，角色會反覆追問用戶早就解決的事（ailiveX 上線前的實際痛點）。

## 4. 讀路徑（檢索與注入）

### 4.1 混合計分（文字路徑，每則訊息都跑）

撈該配對記憶（濾掉 archive／stale／resolved），六種 type **全部**參與相關性計分：

```
score = cosine(query, memory) × 0.7
      + 詞彙重疊率(query詞項, memory內容) × 0.3
      + (tier=core ? 0.06 : 0)
      + (importance - 5) × 0.01
```

- 詞彙重疊是**專有名詞救援**：embedding 對低頻人名／專案代號弱，「小林」「CoWoS」這種詞靠它。
  query 詞項 = CJK bigram ＋ 拉丁/數字整詞（≥2字）。
- 每型有名額上限（fact 4／emotion 2／preference 3／promise 2／question 2／milestone 2）。
- 保底補位：語義和詞彙都無訊號時，前半名額仍按 tier/importance 補（角色不能完全失憶）。
- **不要只讓 fact 走語義**——ailiveX 原版只有 fact 看 query，情緒記憶永遠帶同兩條，體感是「答非所憶」。

### 4.2 Prompt 注入格式（七區塊）

```
【關係】聊過 N 次，第一次是 X 前
【我對這個人的了解】(3天前) …   ← fact，每條帶相對時間前綴
【他的情緒記憶】…
【我記得他的習慣】…             ← preference 不帶時間
【我答應過的事】…               ← promise 不帶時間
【懸而未決的事】…               ← 只帶 createdAt ≥ 7 天的 question（active recall）
【重要時刻】…
```

相對時間前綴（「(今天)」「(3天前)」「(2週前)」）是時間感的來源，靠 createdAt 算——
**讀取函數必須回傳 createdAt**（ailiveX 語音路徑曾漏回這欄，整包時間感變死碼）。

### 4.3 命中計數

被選進 prompt 的記憶 → `hitCount+1`＋`lastHitAt`（非阻塞 fire-and-forget）。
這是 fresh→core 晉升的燃料，**兩條路徑都要 bump**（語音漏掉的話，語音記憶永遠升不了 core）。

## 5. 生命週期（全自動，不靠人按按鈕）

| 轉換 | 條件 | 執行者 |
|------|------|--------|
| fresh → core | hitCount ≥ 3 | 讀時即時 ＋ 每日 cron |
| fresh → archive | 逾 30 天且 hitCount = 0 | 每日 cron |
| core → archive | 逾 90 天未命中 | 每日 cron |
| question → stale | 逾 60 天 | cron ＋ 讀時懶惰 |
| emotion → stale | 逾 90 天 | cron ＋ 讀時懶惰 |
| question → resolved | 對話中被回答 | 萃取時 LLM 判定 |

cron 端點：`/api/cron/memory-maintenance`（Bearer CRON_SECRET 鑑權，Vercel Cron 每日打）。
**沒有 cron 的下場**：ailiveX 原本靠 admin 手動按鈕，陳舊記憶佔滿檢索名額，記憶越用越鈍。

## 6. 語音路徑特有設計

1. **開場注入**：通話開始時用戶還沒說話（無 query），撈 top-15：core 優先 → importance → hitCount。
2. **掛斷收尾（finalize）**：順序＝最不能丟的先做：
   ①快存逐字稿（無 LLM，秒級）→ ②lastSession 快照萃取 ‖ ③記憶萃取（並行）。
   idempotent（Lock＋done flag）。shutdown 寬限至少 90 秒（預設 10s 會把萃取 SIGKILL）。
3. **通話中動態想起**（v15 核心創新，強烈建議移植）：
   ```
   用戶每句 final 發言 → 節流閘（間隔≥45s、前2句不觸發、字數≥6）
   → 背景：query embedding → 對記憶池算 cosine → ≥0.5 取 top2（排除已注入的）
   → 追加進 instructions：【此刻想起】（跟現在聊的有關的舊記憶，自然地用，不要念出來）
   → bump hits
   ```
   節流、門檻、去重全是程式；何時觸發不問 LLM。全程 background task，不佔對話延遲。
4. **lastSession 雙注入**：上次對話摘要（summary＋氣氛＋未完話題）＋「上次聊到最後的原話結尾」
   （逐字稿尾 6 句）。開場指令：第一優先接最新未完的線，不逐句複述、不把記憶當清單念。

## 7. 移植 checklist

- [ ] `memories` collection schema 建立（含 status 欄位，寫入時就給 'active'）
- [ ] embedding 生成接好（兩種 runtime 都要：Node 用 google-auth、Python 用 SA token＋Vertex REST）
- [ ] 寫路徑：萃取 → embedding → **雙門檻去重** → 寫入（兩條路徑同一套參數）
- [ ] 讀路徑：混合計分 ＋ 七區塊 ＋ 時間前綴（確認讀取函數回傳 createdAt/status/hitCount）
- [ ] hitCount bump：文字讀、語音開場、語音動態想起三處都要
- [ ] resolved 機制接進萃取
- [ ] cron 上線並驗證一次真的跑過（看回傳的 promoted/archived/staled 數字）
- [ ] 對等性驗收：逐項對照文字/語音的檢索、萃取、去重、生命週期——**列表打勾，不憑感覺**
- [ ] 終極鑑別信號：**在語音裡講一件事 → 掛斷 → 文字聊天問起它 → 角色要想得起來**（帶時間前綴）

## 8. 踩雷紀錄（每條都是真實流過血的）

1. **兩條路徑分裂**：TS 和 Python 各自演化，語音路徑漏回 3 個欄位 → stale/時間感/active-recall
   全是「看起來有邏輯的死碼」。→ 對照表逐項驗，不假設鏡像。
2. **純 cosine 去重誤殺**：見 §3。長篇敘事記憶必須雙門檻。批次清理時**先抽樣人工驗證再全量**，
   且永不硬刪（標 archive＋dedupOf 欄位，可回溯可回滾）。
3. **embedding 維度漂移**：模型名或 outputDimensionality 改了會靜默存錯維度 → 寫入前驗 768。
4. **萃取被 SIGKILL**：語音 shutdown 預設寬限太短。逐字稿永遠最先存（它是不可再生的真相）。
5. **importance 無鑑別度**：LLM 萃取的 importance 大量擠在 5。可接受（tier/hitCount 補償），
   但別把 importance 當主排序依賴。
6. **`.env.local` 的 SA JSON 有外層引號**（Vercel 格式），`--env-file` 直讀會炸，要手動 strip。

## 9. 參考實作（ailivex-platform repo）

| 模組 | 位置 |
|------|------|
| 文字讀寫全套 | `src/lib/memory.ts`（loadMemoryBlock / writeMemory / extractAndSaveMemories / isDuplicate） |
| embedding | `src/lib/embeddings.ts` |
| 語音讀寫全套 | `agent/firestore_loader.py`（load_memories / write_memory / extract_and_save_memories / generate_embedding / bump_hits） |
| 語音動態想起 | `agent/realtime_agent_v15.py`（`_dynamic_recall` ＋ 節流閘） |
| 生命週期 cron | `src/app/api/cron/memory-maintenance/route.ts` ＋ `vercel.json` |
| Schema 權威定義 | `src/lib/collections.ts` |
| 設計史（WHY） | `docs/MEMORY_ARCHITECTURE_V2.md`（v2 設計意圖）＋ 本文（v3 實戰修正） |

---
*ailiveX 記憶系統 2026-07-03 實戰版。有問題找 Adam 或翻 repo git log。*
