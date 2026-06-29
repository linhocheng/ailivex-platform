# ailivex-platform 技術債審計報告

> 審計日期：2026-06-24  
> 審計方法：靜態掃描（grep / diff / wc）+ 架構閱讀  
> 執行：Task Harness v1 (築)
>
> ⚠️ **審計邊界**：本報告為靜態代碼掃描，以下結論標有 `[待確認]` 者未經動態驗證（如 gcloud run services list、curl 打 endpoint）。Cloud Run service 存活狀態需另行確認後才能執行對應清理動作。

---

## 高優先 ── 可能影響生產或造成混淆

### H1. CLAUDE.md 內部文件聲稱 v10 是 live，但代碼說 v14
- **位置**：`CLAUDE.md:128`（"Current production = v10"）vs `src/lib/collections.ts:112`（`DEFAULT_VOICE_VERSION = 'v14'`）
- **問題**：真相分裂。開發者讀 CLAUDE.md 以為 v10 是現役，實際 token route 全走 v14。新貢獻者/下一個築醒來會誤改 v10 的代碼。
- **影響**：對錯誤版本做改動、debug 時找錯 entrypoint。
- **建議**：更新 `CLAUDE.md` 把 "Current production = v10" 改為 v14，同步版本表格。

### H2. README.md 完全過時
- **位置**：`README.md`（整份）
- **問題**：CLAUDE.md 自己標注「README is stale」，描述 v1–v4，稱 v2 為「現役」。
- **影響**：外部貢獻者或新機器醒來看 README 拿到完全錯誤的系統狀態。
- **建議**：要麼更新（同步到 v14 現況），要麼在 README 頂部加一行 `> ⚠️ 此文件已停止維護，請以 CLAUDE.md 為準。`

### H3. `writing` 和 `web_search` 任務派發未實作但不報錯
- **位置**：`src/lib/task-dispatcher.ts:185,190`
- **問題**：`enqueueWritingJob` 和 `enqueueWebSearchJob` 函數直接 `throw new Error('... not yet connected')`。`writing` 和 `web_search` 都是合法的 `TaskCapability`，如果 admin 授予角色這兩個 capability 後 agent 嘗試 dispatch，會直接拋錯，用戶不知道發生了什麼。
- **影響**：靜默失敗路徑——角色說「幫你搜尋」但後端已拋錯。
- **建議**：在 `task-dispatcher.ts` 的 dispatch 入口加 capability 白名單檢查，未接通的能力提前回 `{ status: 'unsupported' }` 而不是讓錯誤在 fire-and-forget 裡消失；或者從 `TaskCapability` 型別移除這兩個直到接通。

### H4. `src/lib/enqueue.ts` 靜默 no-op ── 比拋錯更危險
- **位置**：`src/lib/enqueue.ts:28`
- **問題**：`enqueueDocumentJob` 在 Cloud Tasks env 未設定時靜默 `console.warn` 然後 return，沒有拋錯、沒有重試、沒有 Firestore 狀態更新。文件任務靜默消失，監控無感。
- **影響**：業務默默失效，比顯式拋錯更難被發現（拋錯至少進 log，no-op 什麼都不留）。
- **建議**：從 codebase 完全移除 `src/lib/enqueue.ts` 並確認所有引用已切換到新路徑；或改為 `throw new Error('Cloud Tasks deprecated, use doc-process route')` 讓失敗可見。

### H5. ~~Admin API 授權邊界~~ ← 已驗證，不成立
- **位置**：`src/middleware.ts:31-38`
- **結論**：middleware 在 Edge 層統一對所有 `/api/admin*` 做 session cookie 驗證 + `session.role !== 'admin'` 攔截（→ 403）。Admin route 本身不需要各自 re-check，middleware 就是那個單一咽喉。CLAUDE.md 說的「Backends always re-check `hasAccess`」指的是角色 access 檢查（dialogue/livekit），不是 admin role——那是設計上的責任分工。
- **行動**：無需修改。

### H6. 全局 Prompt 預設值兩源分裂
- **位置**：`agent/firestore_loader.py:476`（`DEFAULT_GLOBAL_PROMPTS`）和 `src/app/api/admin/global-prompts/route.ts:8`（TS 側的預設）
- **問題**：Python agent 端和 TS admin 端各自維護一份 default，只靠一行注釋提醒「兩邊要同步」。沒有機制強制保持一致。
- **影響**：Python 端改了 default，TS 端沒跟，admin 看到的和 agent 用的不一致。
- **建議**：把 Python 端的 default 移進 Firestore（init script 寫入），agent 不再持有 hardcoded default；或至少加一個 CI check 比對兩邊。

---

## 中優先 ── 累積技術負擔，不影響當下功能

### M1. 13 個版本前端頁面近乎完全重複
- **位置**：`src/app/realtime-v2/` 到 `src/app/realtime-v14/`（共 13 目錄，無 v7）
- **問題**：v2–v10 各版本 page.tsx 幾乎完全相同（diff 只有 2 行：版本 flag 和頁腳標籤）。每份 545 行 × 9 個版本 ≈ 4900 行重複代碼。v11–v14 差異較多（RPC 邏輯、UI 按鈕）但仍有大量共同代碼。
- **影響**：修一個 bug 要改 13 份；token route 現在只走 v14，其餘頁面只能手動打 URL 進入，對一般用戶已無意義。
- **建議**：v2–v10 頁面可以封存（移入 `src/app/_archive/`）或刪除，只保留 base、v11、v12、v13、v14。如果有用戶需要舊版，用 `collections.ts` 的 `VOICE_VERSIONS` 透過 `voiceVersion` access doc 路由。

### M2. Agent Python 版本文件累積 6748 行，v2–v9 為歷史存檔
- **位置**：`agent/realtime_agent_v*.py`（13 份），`agent/main_v*.py`（13 份）
- **問題**：v14 是 live，其餘版本不在 traffic 路徑上，但佔用 codebase 空間且讓 `shared module`（firestore_loader.py、multi_party.py）的向後相容壓力永遠存在。
- **影響**：shared module 每次改動都要確保對 v2–v13 的行為不變，但大多數版本根本沒有 Cloud Run service 在跑（需確認哪些 service 還存活）。
- **建議**：確認 Cloud Run 上哪些版本的 service 已下架，相對應的 `agent/main_vN.py` 和 `realtime_agent_vN.py` 可以移入 `agent/_archive/`；`agent/cloudbuild-vN.yaml` 同步封存。

### M3. 大量靜默 `.catch(() => {})` 無用戶回饋
- **位置**（共 20+ 處，主要）：
  - `src/app/chat/[characterId]/page.tsx:30,31`
  - `src/app/admin/access/page.tsx:27,28`
  - `src/app/stories/[id]/page.tsx:291,317,325,350,378,395,400`
  - `src/app/realtime-v*/[characterId]/page.tsx:428`（多份）
- **問題**：API 失敗後完全靜默，UI 不更新也不提示。用戶不知道操作是否成功。
- **影響**：記憶/任務靜默失敗，admin 操作無回饋，體驗差且難 debug。
- **建議**：至少加 `console.error` 到 `.catch`，關鍵操作（任務觸發、記憶載入）改成顯示錯誤提示。

### M4. `cloud-run/agent/` 是 base agent 舊快照，容易和 `agent/` 混淆（已升 → 見 H5 子項）
- 已在高優先 H5 中處理 enqueue.ts 靜默 no-op 問題。

### M5. `cloud-run/agent/` 是 base agent 舊快照，容易和 `agent/` 混淆
- **位置**：`cloud-run/agent/`（251 行 realtime_agent.py 舊快照）
- **問題**：CLAUDE.md 有警告但仍有混淆風險。`cloud-run/agent/` 和 `agent/` 並存，看名字很像「Cloud Run 用的 agent」。
- **影響**：下一個工程師可能編輯 `cloud-run/agent/` 以為在改生產代碼。
- **建議**：重命名 `cloud-run/agent/` 為 `cloud-run/agent-legacy-base/` 或移入 `archive/`，並在目錄下加 `LEGACY.md` 說明這是 base 版快照。

---

## 低優先 ── 整潔度問題，功能不受影響

### L1. `agent/voiceprint.py` 存在但 v11（唯一使用者）不在 traffic 路徑
- **位置**：`agent/voiceprint.py`
- **問題**：v11 是聲紋識別實驗，collections.ts 注記「未正式上線」，Cloud Run 是否有 v11 service 運行待確認。
- **建議**：確認 v11 service 狀態，若已下架，`voiceprint.py` 同步封存。

### L2. `agent/audio_tap.py` ← 已確認，只被 v11 用（實驗版）
- **位置**：`agent/audio_tap.py`、`agent/voiceprint.py`
- **結論**：兩者只被 `realtime_agent_v11.py` import，v11 是聲紋辨識實驗版，未在 default traffic。`source_intake.py` 原本也在此列，但已確認是 **live 模組**（v12/v13/v14 都 import）。
- **建議**：確認 v11 Cloud Run service 是否還存活，若否，`audio_tap.py` 和 `voiceprint.py` 可隨 v11 一起封存。`source_intake.py` 不是技術債，是現役代碼。

### L3. `scripts/test-enqueue.mjs` 測試廢棄路徑 ← 已刪除
- **位置**：`scripts/`
- **結論**：`test-enqueue.mjs` 已刪除（測試 Cloud Tasks 廢棄路徑）。其餘腳本確認用途：`seed-admin.mts`（建首個 admin 帳號）、`reset-admin-pw.mjs`（緊急重置密碼）、`set-character-aliases.mts`（一次性 migration）、`test-echo.mjs`（確保角色有 script_draft capability）、`query-char.mts` / `query-zhang.mts`（dev 查詢工具）。
- **狀態**：已修。

### L4. 零測試覆蓋
- **位置**：整個 repo
- **問題**：`package.json` 沒有 test 腳本，無任何測試文件。auth / session / memory 邏輯等核心路徑沒有自動化驗收。
- **建議**：至少針對 `src/lib/`（auth-session、auth-password、collections、memory dedup 邏輯）加單元測試。

### L5. `docs/` 設計文件 ← 已確認，不成立
- **位置**：`docs/`
- **結論**：所有文件日期都在 2026-06-08 至 2026-06-22 之間，屬近期。`PLAN_voice_group_and_proactive.md` 是 6/10 的語音群聊計劃書，`PLAN_brand_asset_library.md` 是 6/22 最新。無需加 HISTORICAL 前綴。
- **行動**：無需修改。

---

## 總覽

| 優先 | 條目 | 狀態 |
|------|------|------|
| 高 | H1 文件真相分裂（v10 vs v14）| ✅ 已修（CLAUDE.md 5 處 + 版本表）|
| 高 | H2 README 完全過時 | ✅ 已修（加 stale 警告）|
| 高 | H3 writing/web_search 派發靜默拋錯 | ⏳ 待修（Adam 確認 H3 範圍）|
| 高 | H4 enqueue.ts 靜默 no-op | ✅ 已修（整檔刪除）|
| 高 | H5 Admin API 授權邊界 | ✅ 不成立（middleware 統一守護）|
| 高 | H6 全局 Prompt 兩源分裂 | ⏳ 兩邊目前同步，長期解法待規劃 |
| 中 | M1 13 份重複前端版本頁面 | ✅ 已標記（10 個舊版頁面加 [封存] 備註）|
| 中 | M2 26 份 Python agent 歷史版本 | ⏳ 待確認 Cloud Run service 存活狀態 |
| 中 | M3 20+ 處靜默 catch | ✅ 已修（API 側刻意保留；UI 側 chat/admin-access 改 console.error）|
| 中 | M5 cloud-run/agent/ 混淆 legacy | ✅ 已修（加 LEGACY.md）|
| 低 | L1 voiceprint.py | ⏳ 待確認 v11 CR 存活後封存 |
| 低 | L2 audio_tap.py（source_intake.py 非債）| ⏳ 隨 L1 一起處理 |
| 低 | L3 test-enqueue.mjs | ✅ 已修（已刪除）|
| 低 | L4 零測試覆蓋 | ⏳ 長期，建議從 src/lib/ 開始 |
| 低 | L5 docs/ 文件時效 | ✅ 不成立（所有文件 < 3 週）|

**剩餘待辦**：H3 確認範圍 → H6 長期單源化 → M2+L1+L2 確認 CR service → L4 補測試
