# 記憶全景圖 · 語音道接通（第 3.5 期）架構

> 2026-07-08 · 施工序調整：原第五期的「語音讀取收斂」提前，第四期關係敘事後移。
> 理由：canary 用戶（Adam）主用道是語音，全景圖一~三期全蓋在文字道——用戶感覺不到的功能等於還沒交付。

---

## 調整後的全景圖施工序

| 期 | 內容 | 狀態 |
|---|---|---|
| 一 | 角色日記（文字） | ✅ v16.3.0 |
| 二 | 印象層＋夜間鞏固管線 | ✅ v16.4.0-.2 |
| 三 | 遺忘曲線＋模糊化＋去重放鬆 | ✅ v16.5.0 |
| **3.5** | **語音道接通（本文件）** | **施工中** |
| 四 | 關係敘事＋空白感 | 後移 |
| 五 | 語音「寫路徑」全收斂＋記憶健康觀測台 | 排隊 |
| 六 | 再鞏固＋回灌 ailive 評估 | 排隊 |

---

## 原則（不可違背）

1. **真相一份在 TS**：Python 不重刻任何記憶邏輯（confidence 公式、canary 判斷、信心標記、日記格式都只存在 TS）。Python 只做兩件事：跟 TS 要「組好的塊」、把 transcript 遞給 TS。
2. **語音永不因 Vercel 抖動啞掉**：remote 塊 fetch 失敗/逾時 → fallback 本地舊組裝（v16 現行為）。降級是無聲的，通話照常。
3. **版本紀律**：v16 不動，開 v17。共用檔（firestore_loader.py）只做 additive 修改（新函數＋optional 參數，預設舊行為）。
4. **canary 收斂在 TS**：Python 不知道 canary 存在。TS 端點對 canary 外的用戶回舊格式塊（loadMemoryBlock 本來就會判斷），對 canary 用戶回印象模式塊＋日記塊。

---

## 架構圖

```
【進房（讀）】
agent v17 進房
  ├─（並行）Firestore 本地載入（soul/conv/memories/relationship）← 舊路徑，永遠跑（fallback 備料）
  └─（並行）POST {PLATFORM_URL}/api/agent/memory-blocks  (x-worker-secret, timeout 6s)
              body: {userId, characterId}
              ← TS 端 loadMemoryBlock()（含印象◆◇～/consolidatedInto 過濾/canary）
                 ＋ loadDiaryBlock()（含 unspoken/nextTime/canary）
              → {memoryBlock, diaryBlock} 或逾時 null
  build_system_prompt(..., remote_blocks=(memoryBlock, diaryBlock))
    ├─ remote_blocks 有值 → 六塊記憶段用 memoryBlock 整段替換＋diaryBlock 附加
    └─ None → 舊本地組裝（v16 行為，一字不差）

【掛斷（寫）】
finalize（90s window）
  ├─ ① save transcript（不變）
  ├─ ②③ lastSession + extract_and_save_memories 並行（不變）
  └─ ④ 新增並行：POST /api/agent/diary-write (x-worker-secret)
        body: {userId, characterId, charName, transcript[]}
        ← TS 端 writeDiaryEntry(source='voice')（canary 內建，失敗靜默）
```

## 新增件明細

### TS（Vercel）
| 件 | 內容 |
|---|---|
| `POST /api/agent/memory-blocks` | worker-secret 閘；回 `{memoryBlock, diaryBlock}`；reuse loadMemoryBlock＋loadDiaryBlock，零新邏輯 |
| `POST /api/agent/diary-write` | worker-secret 閘；轉 writeDiaryEntry(source='voice')；回 `{ok}` |
| `middleware.ts` | PUBLIC_PATHS 加兩條（L10 雷：全站閘預設鎖門） |

### Python（agent，additive）
| 件 | 內容 |
|---|---|
| `firestore_loader.py` 新函數 `fetch_remote_memory_blocks()` | httpx POST，timeout 6s，失敗回 (None, None)＋log；不動任何舊函數 |
| `firestore_loader.py` 新函數 `post_diary_write()` | httpx POST，timeout 45s（Sonnet 生成），失敗靜默 log |
| `build_system_prompt(..., remote_blocks=None)` | optional 參數；None＝舊行為位元級不變（v2~v16 全部零影響） |

### v17（版本隔離件）
| 件 | 內容 |
|---|---|
| `agent/main_v17.py` + `agent/realtime_agent_v17.py` | copy v16；進房 fetch remote 塊（與 Firestore 載入並行）；finalize 加 ④ diary |
| `agent/cloudbuild-v17.yaml` | copy v16；服務名 `ailivex-realtime-agent-v17` 出現兩處都改 |
| `src/lib/collections.ts` | VOICE_VERSIONS 加 v17 entry；DEFAULT_VOICE_VERSION **不動**（仍 v16） |
| canary 動線 | `access/{Adam}_{Lilith}` doc 設 `voiceVersion='v17'` ——只有這個配對走 v17，其他人全在 v16 |

---

## 延遲預算

- 進房多一次 Vercel 呼叫：暖 ~300-800ms，與 Firestore 載入**並行**，實際增量 ≈ max(0, fetch − firestore載入時間)
- v16 延遲優化（prewarm/VAD/首段 flush）全保留（copy 基底）
- 逾時 6s 硬上限：最壞情況 = 進房慢 6s 後 fallback，不啞

## 驗證計畫（鑑別信號）

1. 端點：無 secret → 401（出處要是我的 handler，不是 middleware——回 body 驗證）；帶 secret → 200 塊結構
2. 本機：fetch_remote_memory_blocks 對 canary 配對回塊含 ◆/【我私下的日記】字樣（結構斷言，不印全文——L13）
3. v17 部署：Cloud Run service Ready＋LiveKit 註冊 log
4. **Adam 打 v17 通話（唯一的真驗收）**：
   - 掛斷後 `diary` collection 出現 `source='voice'` 文件（結構信號）
   - agent log 出現 `remote_blocks=hit`
   - 隔天再打：角色帶出惦記
5. 回滾：access doc 的 voiceVersion 拔掉＝回 v16，零部署

## 已知不做（留第五期）

- 語音「寫路徑」收斂（extract_and_save_memories 仍是 Python 本地版——與 TS extraction 雙實作的債，第五期併觀測台一起收）
- loader 全瘦身、通話中動態想起（v15 機制）改吃印象層
