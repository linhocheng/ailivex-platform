# Podcast 雙人對話生成系統 — 完整規格書 v1.0

> 2026-07-12 · ailiveX 平台實戰版。給要建「AI 角色對談」的團隊＋他們的 AI。
> 人類請從第一章讀；AI 請直接吃第 9 章機讀區，再回頭抽讀你需要的 why。
> 姊妹篇：`whitepaper-realtime-voice-surge.md`（即時語音防爆）、`spec-elastic-voice-capacity.md`（彈性容量）。

---

## 1. 一句話診斷（為什麼天真的做法必然失敗）

讓兩個 LLM 角色互聊，你會依序撞上兩種病，我們都撞過、都有逐字稿為證：

**病一：收斂病**——「反駁免費、聆聽無報酬、對話無終點」，角色理性地選擇無限反駁。
症狀：同一招句型用十二次、假讓步（「我接——但」）、每句問號結尾的乒乓機、現場捏造
「台大醫師學員」、話題無限後退直到耗盡。**根因：每個 agent 的隱含目標是「不要輸掉這一回合」，
沒有任何人的目標是「一起交出一集作品」。**

**病二：聲音病**——治好收斂之後，角色開始「報告」自己的對話動作而不是「執行」它。
症狀：「我接」「我保留的是」「我們的分歧在」「今天能帶走的一件事」；不知道細節就用比喻填
（「能量沒有出口就是爆炸」「不是在燒你」）。**根因：內部思考和台詞在同一口氣裡生成，
台詞被它剛寫完的協議格式污染——LLM 模仿 context 裡的一切形狀，包括你的規則文本。**

修法不是更強的辯手、不是封鎖詞彙。是**結構**：

- 治收斂：聆聽變成可稽核的前置動作、反駁必須先付立場修正、全場有交付物和有權喊停的人
- 治聲音：思考與說話拆成兩次獨立生成、規則寫在動作層不寫在詞彙層、偵測器退回重講不改寫

---

## 2. 架構總覽

```
L4 導演層   三幕 Orchestrator（程式）＋ Producer（LLM，煞車/地心引力，不進成品）
L3 協議層   THINK/SPEAK 兩段生成 ＋ R1-R6 Validator ＋ MOVE 偵測器（兩層）
L2 靈魂層   persona（soul，不動）＋ Belief State（每集生成）＋ voice{}（後台可編輯）
L1 素材層   角色知識庫當 Evidence Corpus（禁止即興捏第三方案例）
```

單集流程：

```
磨題(人把關) → Belief×2 → ┌ 每輪（程式交替選人）────────────┐
                          │ PASS1 THINK →程式驗+steelman     │
                          │ PASS2 SPEAK →Layer1正則→Layer2 judge │
                          │ → 只有台詞入史                    │
                          └ Producer 觸發器（計數器+掃描）──┘
   三幕出口（程式判）→ EpisodeMeta（交付物齊才准停）→ 殺青自審 → 寫回
```

規模：一集 13–18 輪、約 70–90 次 LLM 呼叫、16–18 分鐘。全部同一顆模型（我們用
Sonnet 4.6 走月費 bridge）；跑在 Cloud Run **Job**（長生成不進 request/response 服務，
見防爆白皮書的 fire-and-forget 天條）。

---

## 3. 三個結構鐵律（先於一切 prompt 技巧）

1. **對話歷史只回灌台詞。** 內部欄位（heard/stance/cost/delta）存 state（我們存 task doc），
   一次都不准進任何 prompt 的 history 區段。模型看過一次「上一輪的我長成結構化欄位」，
   協議洩漏就會回來。
2. **思考與說話是兩次獨立生成。** SPEAK 那一次看不到任何欄位名稱；thought 只以「結論」
   形式傳入（intent 一句＋修正後立場一句＋選中素材的實體內容）。這一刀單獨把我們的
   協議洩漏命中從 26 處砍到 0。
3. **確定性的工作用程式。** 誰下一輪說話（純交替）、問號計數、句型計數、欄位非空檢查、
   幕次預算、出口條件、重試上限——全是 code。LLM 只做四件事：生成台詞、生成思考、
   當 classifier（判定權仍在 code）、當 Producer。JSON 壞了程式重生成，永不 re-ask 模型修。

---

## 4. 呼叫層級全解（每一次 LLM 呼叫的 prompt 組成）

### 4.0 磨題（開錄前，人把關）

題目不會收斂，目標才會。「聊說服」是題目；「一個簡報做得很好、邏輯清晰的人，
為什麼說服不了人？」才是目標——Producer 手上必須拿著後者。

- system：把題目磨成「一集必須回答的問題」＋好目標有張力（兩個專業的人會在上面真的分開）＋對話者名
- user：用戶隨手打的題目
- 輸出進**可編輯欄位**，人確認後才開錄（全流程唯一人工閘）；留空則 job 內代磨

### 4.1 Belief State ×2（每角色，開錄時）

兩個 100% 確信的 agent 只能對撞不能對話——WEAKEST_POINT 給對方靶心，
WHAT_WOULD_CHANGE_ME 讓「被說服」真的可能發生。

- system：`你是{名}`＋soul（≤2000 字）＋「這一集要回答：{goal}」＋「WEAKEST_POINT 是真軟肋，
  對方有權攻打你不得閃躲」＋素材庫標題清單
- 輸出 JSON：coreClaim（≤25 字）／weakestPoint／whatWouldChangeMe（要像一個實驗，禁「有力的證據」空話）／outOfScope
- 程式驗四欄非空，3 次不過→**整集 fail**（誠實中止，不硬上）

### 4.2 PASS 1 · THINK（每輪，想不說）

- system：`你是{名}`＋soul 全文＋立場狀態四欄＋對手名＋goal＋**素材庫完整選單**
  （id｜母文件標題｜出處定位｜摘要 80 字；空庫則明文「你沒有任何真實案例，要舉例只能明說想像」）
- user：對話至此（最近 8 句**純台詞**，含製作人）＋幕指令＋六步：
  1. HEARD——重述對方主張，對方看了會點頭的版本，不准加轉折
  2. STANCE——ACCEPT/PARTIAL/REJECT；PARTIAL 要說清楚接受哪部分
  3. COST——要反駁必先付錢：「我原本主張__→修正成__」；付不出就不准反駁，只剩
     (a) 問真的不知道答案的問題 (b) 往前推進不回頭
  4. INTENT——這輪要達成什麼，動詞開頭
  5. EVIDENCE——選素材庫條目 id（庫裡沒有的真實案例不存在）
  6. BELIEF_DELTA——主張有沒有被動到；碰到 WHAT_WOULD_CHANGE_ME 必須誠實移動
- 驗證：程式判 R1（heard 非空、無「但/不過/可是」）＋R2（REJECT 必付 cost 且 before≠after、
  PARTIAL 必填細節）→ 過了才花一次 **steelman classifier**（下述）。退回→重想，上限 2 次

### 4.3 Steelman classifier（R1 語意面）

- system：「檢查重述是否忠實：原說話者看了會不會點頭。曲解/窄化/稻草人化算不忠實；
  措辭不同主張一致算忠實」
- 輸出 {faithful:bool,why}——**判定權在 code**，classifier 掛了 fail-open（驗收指標會現形）

### 4.4 PASS 2 · SPEAK（每輪，開口——看不到任何協議語言）

- system：`你是{名}`＋soul＋（有填才出現）「你說話的樣子」voice 五欄＋對手名＋主題＋goal
- user：同一個純台詞窗＋幕指令＋「你剛剛在心裡的結論」（intent＋cost.after＋選中素材**實體
  內容**——給細節，治比喻）＋「思考已經發生了，不要報告它，讓它顯示在你說的話裡」＋
  - **MOVE-1**（動作級禁令）：不准報告對話動作——宣告同意/不同意/要反駁/要追問/分歧是什麼/
    要帶走什麼/複述再表態，全禁。真人做，不報。人讓步的方式是改變方向，不是宣布轉彎
  - **MOVE-2**：不准用比喻描述內在狀態（火/流體/容器/能量/機械/層次）——改講當下可觀察行為：
    眼睛看哪、手在幹嘛、講到第幾頁、停了幾秒。想打比方通常是因為不知道細節：用素材的細節，或承認沒有
  - **權利清單**（跟禁令同等重要）：可以說「這個我沒想過」然後停住、可以只說「對」、
    可以問了就閉嘴等、可以講一半改口、**不需要每輪都貢獻新東西——真人不會**
  - （退回時）⛔塊：「你寫了『{原句}』／問題：{診斷}／重講——不要修那一句，重新開口」＋提示
- 輸出：純台詞（無名字標記、無說明）

### 4.5 SPEAK 驗證（兩層偵測器——診斷器，不是改寫器）

```
Layer 1（程式，快、免費、命中省一次 judge）：
  R3 問句衛生（每輪≤1 問號；不得連兩輪問號結尾）
  R5 重複招式（「X跟Y是兩件事」家族全場>3 次即擋）
  MOVE1 種子正則（我接。但／我保留的是／我們的分歧在／今天帶走…）
  MOVE2 種子正則（燒/炸/能量/沒有出口/黑箱/同一層…）
  學習詞庫（voice_lexicon，字面包含比對）
  AI 味模式（抽象體感表達，只診斷，不改寫）
Layer 2（LLM judge，只在 Layer 1 全過時跑）：
  只餵 MOVE-1/MOVE-2 規則＋角色專屬禁區，不餵詞表——靠「動作」判斷才抓得到新變體
  判準明文：「只有明確的病才 fail；偶發自然口語表態、引用對方原話往下挖、講親身經歷
  都 pass。拿不準就 pass——寧可放過，不要把人話磨成假話」
  ＋R4 案例查證：偵測「第三方真實案例聲稱」（拿別人背書：我有一個學員/客戶…）；
  自身親身經歷不算（那是他的人生，不是借來的權威）。聲稱了→evidenceRefs 必須指向
  corpus 真實條目，否則退回：改成聽得出是想像的情境（用自己的話，不給模板句）
自成長：judge 命中而 Layer 1 漏掉 → offending span 自動寫回 voice_lexicon（冪等）。
  跑一個月，詞庫從手寫種子長成「你平台上真的發生過的洩漏總目錄」。
  ⚠️ 詞庫永遠不能取代 MOVE 規則本身；學習條目要定期人工複審（會學到過廣的，見 §7 調音）。
退回紀律：協議類（R1-R4）最多重講 2 次；風格類（MOVE/禁區）**只磨一遍**——
  之後帶 warnings 放行留痕。原因見 §7。
後處理（程式，安全操作不算改寫）：連兩輪句首括號語氣詞硬刪；句型計數過帳。
```

### 4.6 Producer（LLM 煞車；台詞入對話脈絡、不進成品腳本）

LLM 沒有自然結束，只有耗盡——所以要有一個「唯一持有目標的人」。

- persona system：「你不辯論、不表演深度、不說金句。那兩個人的本能是贏，你的任務是讓他們
  交出作品。語氣：短、硬、具體，像一個看著時鐘的人，三句以內」＋EPISODE_GOAL
- 五動作：CUT（壓縮成一句逼確認）／GROUND（漂亮抽象詞拆成三個具體步驟）／AUDIT（查案例）／
  PRESS（把他自己寫的 WEAKEST_POINT 摔到他面前）／LAND（**答案已出現時比他們先認出來**，問要不要停在這裡）
- 觸發器（確定性優先）：假讓步/洩漏計數 ≥3→CUT；連三輪短句且無實例（對聯化前兆）→CUT；
  每 3 輪一次 LLM 掃描 {loop 繞圈, regress 無限後退（第二層就要停，這條線沒有底）, answerEmerged}

### 4.7 三幕（幕次/預算/出口全是程式判）

```
ACT 1 鎖定分歧（4+2 輪）
  出口：distillDisagreement（雙方主張+第一幕逐字稿→「他們的分歧是__」一句）
       ＋confirmDisagreement×2（角色點頭）；不齊→延長 2 輪→Producer 裁定
ACT 2 攻打軟肋（6+2 輪）
  開場 ACT_OPEN 指派戰場（互打對方 weakestPoint，用真實素材）
  出口：≥1 次 belief delta；6 輪零位移→PRESS 點名 WHAT_WOULD_CHANGE_ME＋延長 2 輪；
       仍零位移→誠實記錄（交付物會現形），不假造
ACT 3 落地（4 輪，禁止新議題）
  LAND 開場；最後一輪收尾指令（自然收掉，不制式感謝、不總結、不丟新問題）
出口交付物 generateEpisodeMeta：共識×2＋誠實保留的分歧×1（＋為什麼談不攏——
  比假共識值錢，聽眾要的正是兩個專業的人在哪裡真的分開）＋takeaways×3（動詞開頭）。
  程式驗欄位，3 次不過→整集 fail。終止＝交付物齊了，不是聊到沒話講。
```

### 4.8 殺青自審 ×2（像不像我——與收斂/聲音正交的第三層）

- system：`你是{名}`＋soul＋**程式算好的行為統計**（發言 N 輪、語氣詞開頭 X、複述開場 Y——
  「由程式統計，數字是事實不要懷疑」；模型不會數數，程式會）＋「像不像我」準則
- user：全場編號逐字稿 → 只回「行號: 修改後台詞」或「無」
- 程式複核：只准改自己的句子、不能改空、改寫句再掃 AI 味（帶病改寫保留原句）、前後統計對照留 log

### 4.9 寫回（真相鏈全留）

`podcastScript`（純台詞→編輯器/TTS 管線）＋`podcastTurns`（含 heard/stance/cost/delta/intent/
warnings 的完整內部欄位——驗收表全靠它跑數）＋`beliefStates`＋`producerEvents`＋`episodeMeta`。
內部欄位「後製剪掉」的意思是不進腳本，不是不留檔——不留檔你就沒有儀表。

---

## 5. voice{} — 角色「說話的樣子」（P5：正向描述，不是禁止清單）

LLM 對「不要想大象」極度無能，所以角色語言用正向描述；只有「禁區」一欄給禁令。
五欄，存角色 doc、後台可編輯、空缺＝該面向不個人化（管線照跑）：

| 欄 | 問的是 | 範例（簡報王） | 範例（教練 Tracy） |
|---|---|---|---|
| rhythm | 句長、快慢、講不講完 | 短。急。常常沒講完就換一個 | 慢。會停。問句是真的在等答案 |
| habits | 慣用開場/結尾 | 直接切入，不鋪陳 | 先問一個問題，然後閉嘴 |
| evidenceStyle | 怎麼舉證 | 不打比方，舉例子；給具體的人或不給 | 講現場——那天誰說了什麼、誰臉色變了 |
| whenUncertain | 不知道時 | 說「我不知道」然後停住，不填空 | 「我不確定，我只知道我看到什麼」 |
| forbiddenRegister | 專屬禁區 | 不用心理學術語 | 不用能量/頻率/共振 |

MOVE-1/2 是全平台通用，forbiddenRegister 是角色專屬，兩者疊加。

---

## 6. 實測數據（同題目、同兩角色、四集對照——每刀的貢獻可歸因）

題目：「一個很會教別人上台的人，自己上台前還會緊張——這說明方法失效了，還是方法本來就不是用來消除緊張的？」

| 指標 | 舊管線（單次生成＋動作盤） | ＋協議層 | ＋拆分生成 | ＋偵測器＋voice＋調音 |
|---|---|---|---|---|
| MOVE-1 協議洩漏 | —（病一時代看不到） | 14 | **0** | 0 |
| MOVE-2 抽象比喻 | — | 12 | **0** | 0（邊界 2 待觀察） |
| 立場位移 | 0 | 2 | 7 | **9** |
| 「兩件事」句型 | 12 | 0 | 0 | 0–1 |
| 假讓步（接—但） | 4+ | 2 | 0 | 0 |
| 後半問號結尾 | ~90% | 0–17% | 17% | 0% |
| 字數變異數 std | 極低（對聯化） | 18 | 93 | **95**（29–342 字） |
| 棄權/我不知道 | 0 | 0 | 4 | 4 |
| 具體細節 | ~2 | 0 | 16 | 7 |
| 終止方式 | 耗盡 | 交付 | 交付 | 交付 |

三個最值錢的歸因：**拆分生成一刀砍掉全部協議洩漏**（26→0）；**位移次數隨「被迫真的聽」
上升**（steelman 退回第二次之後緊接著出現該集第一次真實位移，兩集重現）；
**字數變異數是最誠實的指標**——十輪長度一樣＝AI，真人有長有短，有人只說「對」。

---

## 7. 調音教訓（第一版全開必然「修過頭」——執法強度是旋鈕不是越嚴越好）

實踩：偵測器全開的那一集，人一讀就說「修過頭了」。根因＝**退回壓力讓角色過度自我審查**，
不敢說「我同意」、繞開所有自然表態詞，話像在躲地雷。三個旋鈕（都已進上表最後一欄）：

1. **judge 判準明文放寬**：「整句重心就是在報告動作／整段靠比喻撐起來」才 fail；
   偶發口語表態、引用對方原話往下挖、親身經歷都 pass；**拿不準就 pass**——漏抓交給詞庫慢慢學
2. **風格砂紙只磨一遍**：MOVE/禁區類重講一次就放行（協議類維持兩次）
3. **詞庫人工複審**：自成長會學到過廣的條目（例：「我同意的是」整句禁掉會誤傷正常話），修剪掉

還有一課給做量尺的人：**量尺自己也會犯它在抓的病**——我們的驗收正則曾把「說出口」（動詞、
可觀察行為）誤判成「沒有出口」（隱喻），把引用交戰誤判成蓋章複述。發布任何量尺前，
先拿它掃一份已知的好稿，看它冤枉誰。

---

## 8. 驗收方法論（怎麼知道你修好了）

兩套儀表都從 `podcastTurns` 真相鏈**用程式算**（模型不會數數）：

**協議面**（治病一）：位移次數 ≥1 且指得出哪一輪、「兩件事」≤3、假讓步 0、後半問號 ≤40%
且無連續兩輪、未查證第三方案例 0、終止方式＝交付物齊。
**語感面**（治病二）：MOVE-1 命中 0、MOVE-2 ≤1、複述+表態開頭 ≤1 輪、字數變異數要高、
棄權 ≥1、具體細節 ≥6。

**但數字全綠不等於驗完**：驗收表只保證它量到的維度——我們曾經七綠一紅地慶祝一份滿身
新病的稿。最後一關永遠是人用敵意的眼睛讀原文；人讀出的「不對勁」再回頭變成新刻度。

---

## 9. 機讀區（AI 直接吃這段）

```yaml
system: podcast_duo_dialogue
version: 1.0
model_policy: single_model_all_calls   # 我們用 sonnet-4-6 經月費 bridge；長生成跑 Cloud Run Job

invariants:                            # 違反任何一條，兩種病會復發
  - history_feeds_utterances_only      # 內部欄位永不進任何 prompt history
  - think_and_speak_are_two_calls      # thought 只以結論傳入 SPEAK，不傳欄位格式
  - deterministic_work_in_code         # 輪替/計數/出口/重試/JSON修復全是程式
  - rules_live_at_move_level           # 封詞會長出同義詞；詞庫只是偵測快取
  - detector_diagnoses_never_rewrites  # 退回重講；改寫留縫人讀得出
  - termination_is_deliverables        # LLM 沒有自然結束只有耗盡
  - producer_never_in_final_script
  - internal_fields_persisted          # 不留真相鏈就沒有儀表

pipeline:
  - {step: sharpen_goal, gate: human_editable_field, fallback: in_job}
  - {step: belief_state, per: character, fields: [coreClaim, weakestPoint, whatWouldChangeMe, outOfScope], on_fail_x3: abort_episode}
  - loop_turns:
      speaker: code_alternation        # R6 結構性成立
      pass1_think: {out: [heard, stance, partialDetail, cost, intent, evidenceRefs, beliefDelta], retry_max: 2}
      think_checks: {R1: heard_nonempty_no_pivot, R2: reject_requires_cost_change, steelman: llm_classifier_code_decides}
      pass2_speak: {in: [intent, cost.after, evidence_content], sees_protocol_language: false, retry_style: 1, retry_protocol: 2}
      speak_checks:
        layer1_code: [question_hygiene_R3, repeated_move_R5, move1_seed_regex, move2_seed_regex, learned_lexicon, ai_flavor_patterns]
        layer2_llm_only_if_layer1_clean: [move_judge_rules_not_wordlist, evidence_R4_third_party_only]
      lexicon_growth: judge_hit_and_regex_missed -> append_voice_lexicon(idempotent)
  - producer:
      triggers_code: [fake_concede_count>=3, three_short_turns_no_evidence]
      triggers_llm_every_3_turns: [loop, infinite_regress, answer_emerged->LAND]
      actions: [CUT, GROUND, AUDIT, PRESS, LAND, ACT_OPEN]
  - acts:
      act1: {budget: 4+2, exit: disagreement_statement_confirmed_by_both_else_producer_rules}
      act2: {budget: 6+2, open: assign_battlefields_from_weakest_points, exit: belief_delta>=1_else_PRESS_then_honest_record}
      act3: {budget: 4, no_new_topics: true}
  - episode_meta: {consensus: 2, preserved_disagreement: 1, takeaways: 3, on_fail_x3: abort_episode}
  - self_review: {per: character, mirror: code_computed_stats, may_edit: own_lines_only, rescan_after_edit: true}

judge_calibration:                     # 第一版全開必然修過頭
  fail_only_when: sentence_centers_on_reporting_or_metaphor
  pass: [casual_stance_words, quoting_opponent_to_dig, first_person_lived_experience]
  when_unsure: pass                    # 漏抓交給詞庫學，錯殺把人話磨成假話
  style_retry_cap: 1
  lexicon_needs_periodic_human_prune: true

acceptance_targets:
  protocol: {belief_deltas: ">=1", two_things_pattern: "<=3", fake_concede: 0, second_half_question_ratio: "<=0.4", unverified_third_party_cases: 0, termination: deliverables}
  voice: {move1_hits: 0, move2_hits: "<=1", echo_stance_openings: "<=1", length_std: high, abstentions: ">=1", concrete_details: ">=6"}
  final_gate: human_reads_transcript_adversarially   # 數字全綠不等於驗完

measured_reference:                    # 我們的四集同題對照（sonnet-4-6）
  split_generation_alone: {move_hits: "26->0"}
  full_stack_calibrated: {belief_deltas: 9, length_std: 95, question_endings_second_half: 0, duration_s: ~1074, llm_calls: 70~90}
```

---

## 10. 移植最快路徑

```
[ ] 1. history 只回灌台詞（一行程式，先做——它一個人殺掉一半的洩漏）
[ ] 2. 拆 THINK/SPEAK 兩次呼叫；thought 存 state 永不進 history
[ ] 3. 跑一集，量 MOVE 命中掉多少（我們：26→0）——先只做 1-3，其他不動
[ ] 4. Belief State 開錄生成＋R2 反駁計價＋steelman gate（位移會開始出現）
[ ] 5. 三幕＋Producer（終止=交付物；答案出現要比角色先認出來）
[ ] 6. PASS 3 兩層偵測器＋詞庫自成長（記得 judge 判準放寬＋風格只磨一遍）
[ ] 7. voice{} 五欄進角色後台（正向描述；空=不個人化）
[ ] 8. 兩套驗收儀表跑同題對照；最後一關人讀原文
```

第 1-3 項做完就值回票價。第 6 項不校準必然修過頭——直接抄 §7 的三旋鈕。

---

*來源：ailiveX 2026-07-11 一天四集同題迭代實戰。兩份上游規格書（對話協議 v1／Voice Layer v1）*
*由 Adam 提供診斷與設計，本文件是落地後的合訂本＋實測數據＋調音教訓。*
