# FOUNDATION — ailiveX 地基帳本

> 母版：`~/.ailive/zhu-core/skills/platform-foundation/BLUEPRINT.md` v1.1
> 建立：2026-07-19（平台地基天條回溯補建——ailiveX 是既有平台，非新開工）
> 規則：地基狀態只有 已灌/排後/砍掉；承重牆帳守「無聲消失會打到真人」的 invariant；
> 技術債看利率不看年齡。需求變動第一動作回這裡重算；lastword 盤到期。

ailiveX 已上線數月，這份是**現況盤點**，不是開工調度。重點在承重牆帳與技術債帳——
把散在 session note、只有我腦子記得的載重決策釘住，讓下一個 session（人或 agent）
被迫讀到，而不是各自重新踩一次雷。

---

## 地基狀態（現況盤點）

| # | 地基 | 狀態 | 說明 |
|---|---|---|---|
| 1 | 身份與門禁 | 已灌 | scrypt 密碼＋HMAC session cookie；middleware gate 頁面＋每 route 重驗 hasAccess；user/admin 兩層。**手刻 auth（非託管服務）＝顯式偏離，見技術債 D3** |
| 2 | 資料憲法＋生命週期 | 已灌（生命週期部分排後） | collections.ts 是憲法，(userId×characterId) 綁定寫死；記憶有 tier/status 雙軸。封存/刪除路徑：memories 有 stale/resolved，但**用戶級資料刪除連帶**（刪角色→記憶/對話/日記孤兒）排後 |
| 3 | 安全與威脅防禦 | 部分灌·掃描鏈排後 | secrets 進 Secret Manager；SSRF guard（url-reader）；prompt injection 靠 R12-14 紀律。**掃描四件套接 CI 未做**（排後→觸發：接第二個真租戶/對外開放） |
| 4 | 住戶行為與濫用 | 部分灌 | access 白名單制（非公開註冊）；bridge 吃到飽對沖 LLM 成本。rate limiting 排後（現非公開，觸發：開放註冊） |
| 5 | 可觀測性 | 已灌 | 記憶觀察者巡檢（台北 04:00 cron）＋zhu_vitals_cost；voice-end log |
| 6 | 任務基建 | 已灌 | doc-worker Cloud Run（900s）；job 四件套；watchdog |
| 7 | 後台 | 已灌 | /admin 四頁＋記憶健康面板＋監控中台 |
| 8 | 部署與環境 | 已灌 | voice agent vN append-only 隔離；Vercel + Cloud Run；secrets Secret Manager |
| 9 | 成本結構 | 已灌 | bridge 優先；voice turn-path 直連 key（bridge 無串流）；min=1 常駐已知 |
| 10 | 災難與還原 | 已灌（2026-07-19） | Firestore PITR 7 天＋每日 export 排程＋drill 還原演練通過。SOP：zhu-core/docs/FIRESTORE_BACKUP_RESTORE.md |
| 11 | 擴建預留 | 已灌 | voice version vN 制；多租戶（userId×characterId）；表達層/方法論提案管道 |

---

## 承重牆帳（無聲消失會打到真人的 invariant）

pinning test 在 `tests/test_load_bearing.py`（9 個，離線可跑，不需 Firestore 憑證）。
**pinning test 變紅＝系統在正常運作**；禁 skip/xfail/刪測讓 CI 綠。
跑法：`python3 tests/test_load_bearing.py` 或 `python3 -m pytest tests/test_load_bearing.py -q`。

| # | invariant | 基線 | 來源 commit | code anchor | pinning test |
|---|---|---|---|---|---|
| LB1 | 角色靈魂永不無聲消失 | soul 有值時逐字進 system prompt 且在開頭 | （244字fallback事件，見 feedback_shared_loader_nameerror_silent_soulless） | `firestore_loader.py::build_system_prompt` L793 | `test_lb1_soul_appears_verbatim` / `_is_the_head` |
| LB2 | 反討好天條全局恆注入 | 每個 prompt 含「比討好更重要的事」 | v18.13 表達層 | `firestore_loader.py::DEFAULT_GLOBAL_PROMPTS.antiSycophancy` | `test_lb2_anti_sycophancy_always_injected` |
| LB3 | 判斷腦 go/no-go 是確定性代碼 | should_grab_floor 純函數回 bool、不碰 LLM | `bc1bf9e` v8.0 | `conv_tuning.py::should_grab_floor` L236 | `test_lb3_*`（3 個） |
| LB4 | memories 寫入必帶 status='active' | 收斂點 doc literal 寫 status | `17b2d84` v18.14.1 | `memory.ts::writeMemory` L268 | `test_lb4_write_memory_sets_status_active` |
| LB5 | 記憶檢索綁 (userId AND characterId) | 每查詢雙 where、成對 | `00f...`（綁定自始） | `memory.ts` L104-105/313/458 | `test_lb5_memory_queries_scoped_to_user_and_character` |
| LB6 | 語音 TTS 簡體規則不可失 | voiceRules 含「简体中文」 | — (prose-pinned 前) | `firestore_loader.py::DEFAULT_GLOBAL_PROMPTS.voiceRules` | `test_lb6_voice_tts_simplified_rule` |

**動到承重牆檔案**（`firestore_loader.py`、`conv_tuning.py`、`memory.ts`、`persona`、
`collections.ts`）的改動，PR/session note 必須聲明：
`preserved baselines: <list>` 或 `moving baseline: <哪條>·<為什麼>·<證據>`，並重跑上表。

### 未有自動測試守的承重牆（prose-pinned，補測優先清單）
- voice agent vN append-only 隔離（實驗不碰現役版）——現靠 CLAUDE.md 紀律
- doc/text 輸出鏈「轉繁→句型過濾→轉繁」兩出口都要套
- global prompts 雙份（Python + TS route）改一邊要改另一邊

---

## 技術債帳

| 債 | 利率 | 清償事件 | 記錄日 | 狀態 |
|---|---|---|---|---|
| D1 掃描四件套未接 CI（SAST/SCA/祕密/DAST） | 壓底 | 接第二個真租戶或對外開放前 | 2026-07-19 | 待清（2026-07-19 ZAP 手動掃過一輪、security headers 已補；剩 CI 自動化） |
| D6 CSP 為保守版（無 script-src，ZAP 仍列 unsafe-inline×3） | 壓底（要防 XSS 才算真擋） | 真要防 XSS 縱深時升級成 nonce-based CSP | 2026-07-19 | 顯式養著（保守版補了 frame-ancestors 等防護且零打爛，但擋不住 inline-script XSS；ZAP 重掃 CSP 從「未設」變 3 條 unsafe-inline，需 nonce 根治，會打爛 Next.js SSR 是獨立工程） |
| D2 用戶級資料刪除無連帶（刪角色留記憶/對話孤兒） | 低利 | 需要真的刪一個角色/用戶時 | 2026-07-19 | 顯式養著 |
| D3 手刻 auth（scrypt+HMAC，非 Clerk/Supabase Auth 託管） | 低利 | 對外開放註冊、或出現 auth 相關事故時重估 | 2026-07-19 | 顯式養著（能跑、無事故，雙向保護：不順手換、不挖深） |
| D4 v19 min=1 第二台常駐雙付 | 壓底 | v19 語音實測收案後二選一（轉正/降0） | 2026-07-18 | 待清 |
| D5 global prompts 雙份（Python+TS）易漂移 | 低利 | 下次改 default 時順手收斂或加同步測試 | 2026-07-19 | 顯式養著 |

利率：活血=立刻清｜壓底=動工前清｜低利=順手清或顯式養著。
顯式養著雙向保護：不在不相關改動裡順手「修好」，也不挖深；退場條件已寫在清償事件欄。
升級規則：同一繞法連續兩場 session 被重新解釋＝高利貸，下場優先。

---

## 變動記錄
- 2026-07-19 建帳（回溯）：承重牆帳＋pinning test 9 個上線；災難還原地基補灌（PITR+export+drill）
- 2026-07-19 ZAP baseline 掃描（FAIL-NEW 0，60 PASS）→ 補全站 security headers（CSP 保守版/COOP/HSTS/nosniff/frame DENY/Referrer/Permissions），curl 驗 7 header 全生效
- 2026-07-19 重掃鑑別信號（誠實）：clickjacking/資訊洩漏/傳輸安全真消失、Low 大降；但 CSP「未設」→ 3 條 unsafe-inline（保守 CSP 擋不住 inline XSS）＝數字面 Medium 未降，記 D6 壓底債。「消 Medium」的初報被重掃打臉，此為修正
