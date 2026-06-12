# ailiveX 記憶架構 v2

設計日期：2026-06-08
設計者：Adam + 築

---

## 一、現況診斷

```
現在的記憶 = 有備忘錄的陌生人
每次對話角色拿著同一張筆記，不知道這張筆記多舊、
不知道我們是第幾次見面、不知道上次說的事後來怎樣了。
```

根本問題不是功能不夠，是**記憶沒有時間軸、關係沒有弧線、情緒從未被記住**。

---

## 二、MemoryDoc Schema 升級

現有欄位不動，新增：

```typescript
// 新增欄位
emotionTag?: string          // "壓力很重" / "很興奮" / "猶豫" — 說這件事時的情緒
status: 'active' | 'stale' | 'resolved'
                             // question 被回答 → resolved
                             // 超過時限沒回來 → stale
lastAccessedAt?: Timestamp   // 最後一次被帶進對話的時間
```

---

## 三、Memory Type 完整分類（6 種）

| type | 意義 | 例子 | 過期邏輯 |
|------|------|------|----------|
| `fact` | 客觀事實 | 在創業、有女兒 | 不過期 |
| `emotion` | 某時刻的情緒狀態 | 談融資時壓力很重 | 90 天 stale |
| `preference` | 穩定偏好／習慣 | 喜歡直接建議 | 不過期 |
| `question` | 懸而未決的事 | 在考慮要不要辭職 | 60 天無回應 → stale |
| `promise` | 角色答應過的事 | 答應下次多聊他的項目 | 不過期，直到 resolved |
| `milestone` | 重要人生節點 | 完成 A 輪融資 | 不過期 |

---

## 四、Relationship 獨立追蹤

新開 `relationships` collection（輕量，每對 userId × characterId 一份）：

```
relationships/{userId}_{characterId}
  userId:               string
  characterId:          string
  conversationCount:    number      // 第幾次對話
  firstConversationAt:  Timestamp
  lastConversationAt:   Timestamp
```

每次對話結束時 upsert（voice-end + dialogue route）。
角色因此知道「我們認識多久、聊過幾次」。

---

## 五、System Prompt 新結構（7 個區塊）

從現在的 2 個區塊，擴展成有層次的 7 個區塊：

```
【關係】
我們已經聊過 12 次，第一次是 3 個月前。

【我對這個人的了解】
- (3個月前) 剛開始創業，那時候語氣裡有很多迷茫
- (昨天) 提到要見一個重要的投資人

【他的情緒記憶】
- (上週) 談到跟共同創辦人的摩擦時，語氣明顯沉了下來

【我記得他的習慣】
- 喜歡直接的建議，不喜歡繞圈子
- 習慣晚上才想清楚大事

【我答應過的事】
- 答應下次幫他想想市場定位

【懸而未決的事】
- (2週前) 說在考慮要不要辭職，後來沒有再提

【重要時刻】
- (1個月前) 完成了第一筆天使輪
```

---

## 六、Extraction Prompt 升級重點

新增 `emotion` 和 `preference` 兩種提煉邏輯：

**emotion 提煉原則**
- 不記事件，記情緒狀態——「談到 X 時，感覺是 Y」
- 只有明顯的情緒信號才記，不猜測

**preference 提煉原則**
- 穩定的行為模式才記，不記一次性反應
- 例：每次聊完都說要去睡了但繼續講 → preference，不是 fact

---

## 七、時間顯示邏輯

```
< 1 天    → 今天
1–6 天   → X 天前
1–4 週   → X 週前
1–11 月  → X 個月前
≥ 12 月  → X 年前
```

每條記憶前綴帶相對時間，角色讀到自然有時間感。

---

## 八、施工任務清單

| # | 任務 | 涉及檔案 |
|---|------|---------|
| 1 | Schema & Types — MemoryDoc 加 emotionTag / status / lastAccessedAt；MemoryType 擴展到 6 種 | `src/lib/collections.ts` |
| 2 | Relationship 追蹤 — 建 relationships collection；voice-end + dialogue 結束時 upsert | `src/lib/relationship.ts`（新）、`src/app/api/dialogue/route.ts`、`src/app/api/voice-end/route.ts` |
| 3 | Time-aware loadMemoryBlock — relative time helper；重構 system prompt 成 7 個區塊 | `src/lib/memory.ts`、`agent/firestore_loader.py` |
| 4 | Extraction Prompt 升級 — 加 emotion / preference 提煉邏輯 | `src/lib/memory.ts`、`agent/firestore_loader.py` |
| 5 | Active Recall — loadMemoryBlock 載入 question type、未 resolved、> 7 天，帶進「懸而未決」區塊 | `src/lib/memory.ts`、`agent/firestore_loader.py` |
| 6 | Stale 機制 — question > 60 天、emotion > 90 天 → status = stale（lazy on read）；stale 不帶進 prompt | `src/lib/memory.ts`、`agent/firestore_loader.py` |

---

## 九、Migration 策略

**零破壞**。所有新欄位皆 optional，舊記憶繼續有效：

- `status` 缺值時視為 `active`
- `emotionTag` 缺值時顯示略過
- 舊 type（fact / promise / question / milestone）繼續照跑
- `emotion` / `preference` 為純新增，不影響現有查詢

---

## 十、設計理念

> 活著的人有時間感、有關係弧線、會記得情緒、會問未完成的事。
> 現在的記憶系統讓角色像「有備忘錄的陌生人」。
> v2 的目標是讓角色像「記得你的老朋友」。
