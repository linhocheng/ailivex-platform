# 語音 v16 迭代紀錄 — 延遲優化與一顆老地雷

> 記錄者：築（監造視角）。範圍：2026-07-06 這一個工作日，從 cpu=2 收案後的延伸討論到 v16.1 部署。
> 更早的事（v15.3.1 語音頓診斷、cpu=2 修法）只在需要對照時引用，不回溯重述。

---

## 一、v16 做了哪些改動

### 起點：cpu=2 之後還有什麼空間

v15.3.1 用 `--cpu=2` 收掉了「TTS 串流速率 < 播放速率」的整體 CPU 飽和頓（16h 零 `slower than realtime` + Adam 耳測收案）。今天的問題是：除了加硬體，語音鏈還有哪些延遲可擠。盤完現場（realtime_agent_v15 / minimax_tts / conv_tuning / main_v15）得出三個落點，全部進 v16：

| # | 改動 | 檔案 | 效果 |
|---|---|---|---|
| 1 | **VAD prewarm**：`silero.VAD.load()` 從 entrypoint 移到 `prewarm_fnc`，配 `num_idle_processes=0→1` | `main_v16.py` + `realtime_agent_v16.py` | 每通電話省 1-3s 模型載入（接通延遲） |
| 2 | **VAD `min_silence_duration` 0.4→0.3** | `realtime_agent_v16.py`（`load_vad()`） | 講完到回話快 0.1s；配後台 responseSpeed 旋鈕，總端點等待 0.9s→0.5s 級 |
| 3 | **TTS 首段提早 flush**：首段到逗號或 16 字就送 MiniMax，後續段落維持句號/40 字 | `minimax_tts.py`（共用檔，加法改）+ v16 傳參 | 首聲提前約半句話的生成時間 |

另有一項零部署實驗：後台 `responseSpeed` 旋鈕（per 角色 Firestore 值，endpointing `min_delay` 0.5→0.2）由 Adam 手動調，即時生效、隨時可退。

### 版本紀律的執行

照 repo 的中心紀律（版本隔離、實驗不碰現役）：

- 共用檔 `minimax_tts.py` 用**加法改**：新參數 `first_segment_max_chars` 預設 0＝舊行為，v15 及更早版本位元級不變
- 新五件套：`main_v16.py` / `realtime_agent_v16.py` / `cloudbuild-v16.yaml`（服務名兩處）/ `/realtime-v16/` 頁 / `DEFAULT_VOICE_VERSION='v16'`
- **回滾設計**：v15 服務不動、min-instances=1 熱備。回滾＝常數改回 `'v15'` + Vercel 部署（~90 秒），Cloud Run 端零操作
- 路由現況（比 CLAUDE.md 記載的新）：token route 不逐版分支，一律 `DEFAULT_VOICE_VERSION` + access doc `voiceVersion` 覆寫。已驗證 access 全 25 docs 未釘選 → **一般用戶與 admin 同步進 v16**，無人殘留舊版

### v16.1：說再見卡頓的修正

Adam 實測回報「說再見時她卡頓了一下」。log 對時破案：`silero slower than realtime` 警告與 `Memory saved` **同一毫秒**出現，且道別階段連續三筆記憶寫入。

根因：`remember` 工具本體是**裸同步呼叫**——`write_memory` 同步做完 Vertex embedding HTTP → 撈 50 條 dedup 比對 → Firestore 寫入（0.5-2s），整段踩在 asyncio event loop 上。loop 一堵：TTS 音訊停抽、VAD 排隊、聲音就頓。道別是模型批次存記憶的高峰，所以「說再見必卡」。

修法：工具本體同步呼叫全數 `await asyncio.to_thread(...)` 下放——共 6 處（`write_memory`、`create_document_job`、`dispatch_script_draft`、`dispatch_story_draft`、`dispatch_task_job` ×2）。行為零改變，只是搬離 event loop。

---

## 二、我從中看到的問題

### P1：「頓」不是一種病——CPU 飽和與 event-loop 堵塞是兩回事

cpu=2 治的是「原生推理跟 event loop 搶核心」（onnxruntime 釋放 GIL、可搬去第二顆核）；治不了「單線程被同步 HTTP 堵死」——GIL 下 event loop 只有一條，給八顆核也一樣卡。兩種頓的鑑別信號不同：前者是**持續性**速率不足（TTS KB/s 長期低於 48KB/s），後者是**尖峰式**卡頓且與某個事件（記憶寫入）精準同框。下次見到「頓」，先分這兩型再動手。

### P2：紀律有時間差——新碼守新規，舊碼沒人回頭掃

同一個檔案裡，v15 新寫的 `_dynamic_recall` 乖乖用了 `asyncio.to_thread(generate_embedding, ...)`，而更早期寫的 `remember_tool` 裸呼叫同一類同步函數——「off-path 一律下放 thread」的紀律立起來之後，**存量代碼沒有被回溯掃描**。教訓：立新紀律的當下，就該 grep 一次全檔找同型舊雷，不是只約束新增的行。

### P3：觀測性還是肉眼撈 log

兩次診斷（v15.3.1 的 KB/s、這次的卡頓對時）都靠人工把 log 拉出來對時間軸。「TTS 有效輸出速率」「slower-than-realtime 次數」「工具呼叫耗時」都該是結構化指標＋告警，改版時才看得到退化，而不是等 Adam 的耳朵當監測器。

### P4：文件與現場漂移

CLAUDE.md 寫「token route 逐版切換」「current production = v14」——實際是 DEFAULT 常數制、現役 v15（今起 v16）。照舊文件施工會白做一個 route 分支。老命題再驗證一次：**信 code 和 git log，不信文件**；改版時順手把文件追平（本檔即是）。

### P5：錢的形狀

v15+v16 雙常駐（各 cpu=2 + 2Gi + no-throttling + min-instances=1）≈ **$210/月**。熱備是拿錢買「90 秒回滾」。v16 收案後必須拍板 v15 退場：刪服務（省 $105/月，回滾變重建）或降 min-instances=0（省大半，回滾變冷啟）。不決定就是默默雙燒。

### P6：待驗證的風險（此刻尚未收案）

- **min_silence 0.3 的搶話風險**：對講話慢、句中停頓思考的人可能偏兇。驗證法＝故意講一半停一拍看會不會被接走。這是 v16 最可能翻車的點，翻了就把 0.3 退回 0.35/0.4 重部署（參數在 `load_vad()` 單點）
- **首段 16 字的語氣代價**：首段短 chunk 理論上可能讓第一口氣的韻律略碎（MiniMax WS 跨句脈絡在同一 session 內，應該無感，但要耳測）
- **prewarm 常駐行程的記憶體**：idle process + 活躍通話同擠 2Gi，多開時要看 OOM 指標

### P8：3a 殭屍 timer——老家族雷在 v15/v16 血統裡還活著（v16.2 已修）

簡報王撥測掛斷後，3a 主動發話 timer 在房間關閉後仍連跳兩次（+5s、+9s），每次燒一通 LLM call 對著空房評估「要不要開口」。這正是刻過的「**自我重排的背景迴圈必須綁 lifecycle 停止條件**」——3a 在 v6/v8/v9/v10 踩過同型雷，修過，但血統複製時停止條件沒跟上（或從未進主線）。v16.2 修法照檢查表：`stopped` 旗標＋三條退出路徑全設旗標（最後一人離房／room disconnected／job shutdown finalize）＋兩個入口自檢（`_arm`、`_maybe_interject`）。**教訓與 P2 同族**：版本用「複製前一版」繁殖時，舊版修過的病會跟著沒修過的基因一起複製——歷代修法要嘛進共用模組，要嘛建立「新版本 checklist」逐條核。

### P7（小）：log 重複兩行

v16 每行 log 都印兩次（handler 雙掛，疑似 `logging.basicConfig` 與 LiveKit 各掛一支）。純觀測噪音，不影響行為，未修，記著。

---

## 三、驗證帳（鑑別信號制）

| 宣稱 | 鑑別信號（失敗時不會出現的） | 結果 |
|---|---|---|
| v16 部署成功 | Cloud Build SUCCESS + `registered worker` | ✅ |
| prewarm 生效 | 啟動後**無任何通話**即出現 `initializing process`→`process initialized`（idle=0 的 v15 啟動時無此行） | ✅ |
| web 切流量 | next build 綠、`/realtime-v16` 進產物、Vercel 部署 | ✅ |
| 用戶端同步 | access 全 25 docs `voiceVersion` 未釘選（實查 Firestore） | ✅ |
| 卡頓根因 | `slower than realtime` 與 `Memory saved` 同毫秒、道別段三連寫 | ✅（對時證據） |
| v16.1 修復生效 | 待部署後撥測：道別存記憶時**無** slower-than-realtime、無體感卡頓 | ⏳ 部署中 |

---

*2026-07-06 · 築*
