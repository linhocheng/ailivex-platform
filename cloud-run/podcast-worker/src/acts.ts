/**
 * L4 導演層 — 三幕 Orchestrator（duo 主循環）
 *
 * 幕次、輪替、預算、出口條件全是程式判；Producer（Sonnet）只在被觸發或
 * 幕界時說話。雙人輪替是純程式交替（R6 從結構上不可能違反——原逐字稿的
 * 開場 bug 在這裡根絕）。終止 = 交付物齊了，不是聊到沒話講。
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type DuoChar, type DuoTurn, type ProducerEvent, type EpisodeMeta,
  type BeliefState, type BeliefDeltaRecord, type BridgeCall, type CorpusEntry,
  type AudienceMirror, type TensionMap, type CollisionQuestion, DUO_MODEL, extractJson,
} from './duo-types.js';
import {
  loadProducerSoul, designTensionMap, detectAudienceEscape, convergeScript,
  type RefocusState, type ConvergenceResult,
} from './invisible-producer.js';
import { loadCorpus, generateBelief } from './belief.js';
import { loadSeriesContext, type SeriesContext } from './series.js';
import { thinkTurn, speakTurn, type HistoryLine, type Thought, type SpeakRetry } from './protocol.js';
import {
  checkThink, checkSpeak, checkSteelman, checkEvidence,
  countQuestions, endsWithQuestion, TWO_THINGS_RE, type Violation,
} from './validators.js';
import {
  newTriggerState, detectTrigger, llmTriggerScan, produceUtterance,
  distillDisagreement, confirmDisagreement, generateEpisodeMeta,
} from './producer.js';
import { detectLeadingTic, stripLeadingTic } from './rhythm.js';
import { scanText } from './text-filter.js';
import { loadLexicon, layer1Check, layer2Judge, learnPhrase, diagnoseMetaphor } from './voice-rules.js';

const ACT1_EXT = 2;
const ACT2_EXT = 2;
const MAX_REGEN = 2; // 每輪最多重生成次數（之後帶 warnings 放行，誠實留痕）

/** 時長 → 幕次預算。UI 的分鐘數（×500 字）換算輪數（每輪實測均值 ~250 字），
 *  三幕比例 30/45/25，下限保住三幕結構、上限擋住馬拉松。EXT 不變。 */
function actBudgets(wordCount: number): { act1: number; act2: number; act3: number } {
  const total = Math.max(7, Math.min(20, Math.round((wordCount || 2500) / 250)));
  const act1 = Math.max(2, Math.round(total * 0.3));
  const act3 = Math.max(2, Math.round(total * 0.25));
  const act2 = Math.max(3, total - act1 - act3);
  return { act1, act2, act3 };
}

export interface DuoResult {
  turns: DuoTurn[];
  producerEvents: ProducerEvent[];
  beliefs: Record<string, BeliefState>;
  audience: AudienceMirror;
  seriesContext?: string; // 本集實際餵入的節目記憶（真相鏈可稽核）
  tensionMap?: TensionMap;              // 無形製作人前製：張力地圖
  collisionQuestions?: CollisionQuestion[]; // 無形製作人前製：五問
  producerEpilogue?: string;            // 無形製作人後記
  convergence?: Omit<ConvergenceResult, 'epilogue'>; // 收斂台統計
  meta: EpisodeMeta;
}

/** episodeGoal 沒進來（舊入口）時的 job 內磨題 fallback：題目不會收斂，目標才會 */
async function sharpenGoal(bridgeCall: BridgeCall, topic: string | undefined, chars: DuoChar[]): Promise<string> {
  const raw = await bridgeCall(
    DUO_MODEL,
    `把一個聊天題目磨成一集對話「必須回答的問題」。題目不會收斂，目標才會：「聊說服」是題目；「一個簡報做得很好、邏輯清晰的人，為什麼說服不了人？」才是目標。對話者：${chars.map(c => c.name).join('、')}。只輸出那一個問題，一句話，問號結尾。`,
    `題目：${topic?.trim() || '（未指定，從兩位對話者的專業交集出題）'}`,
    100,
  );
  const goal = raw.trim().replace(/^["「『]|["」』]$/g, '');
  if (!goal) throw new Error('磨題失敗：EPISODE_GOAL 生成為空');
  return goal;
}

/** 聽眾鏡像沒進來（舊入口／人沒填）時的 job 內 fallback。
 *  生成失敗降級為通用聽眾——聽眾是動力源不是閘門，缺它不該讓整集死。 */
async function generateAudience(bridgeCall: BridgeCall, episodeGoal: string): Promise<AudienceMirror> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await bridgeCall(
        DUO_MODEL,
        `一集雙人對話節目要回答：「${episodeGoal}」。想像今晚最需要這一集的那個聽眾——不是「大眾」，是一個具體的人。輸出純JSON：{"persona":"他是誰，一句話，帶處境（例：常被客戶拒絕、內向的年輕業務）","misconception":"他帶著什麼誤解走進來（例：以為說服別人一定要口若懸河）"}`,
        '請描述這個聽眾。',
        200,
      );
      const p = extractJson<{ persona?: string; misconception?: string }>(raw);
      if (p?.persona?.trim() && p?.misconception?.trim()) {
        return { persona: p.persona.trim().slice(0, 100), misconception: p.misconception.trim().slice(0, 100) };
      }
    } catch { /* 重試 */ }
    console.warn(`[duo] audience 第 ${attempt + 1} 次生成不合格，重生成`);
  }
  console.warn('[duo] audience 生成失敗，降級為通用聽眾');
  return { persona: `對「${episodeGoal.slice(0, 30)}」有切身困擾、想聽到能用的做法的人`, misconception: '以為這個問題有一個標準答案' };
}

export async function runDuoScript(
  db: Firestore,
  bridgeCall: BridgeCall,
  characters: DuoChar[],
  opts: {
    taskId?: string;                    // 節目記憶查詢時排除自己
    episodeGoal?: string;
    topic?: string;
    focus?: string;
    audience?: Partial<AudienceMirror>;
    briefs?: Record<string, string>;    // characterId → 製作人開錄前的私下交代
    wordCount: number;
    filterPatterns: Array<{ id: string; re: RegExp }>;
  },
): Promise<DuoResult> {
  if (characters.length !== 2) throw new Error('duo 管線只收兩個角色');
  const [a, b] = characters;

  // ── 前置：目標＋聽眾鏡像＋素材庫＋立場狀態 ──────────────────────────
  const episodeGoal = opts.episodeGoal?.trim() || await sharpenGoal(bridgeCall, opts.topic, characters);
  console.log(`[duo] EPISODE_GOAL: ${episodeGoal}`);

  const audience: AudienceMirror = (opts.audience?.persona?.trim() && opts.audience?.misconception?.trim())
    ? { persona: opts.audience.persona.trim(), misconception: opts.audience.misconception.trim() }
    : await generateAudience(bridgeCall, episodeGoal);
  console.log(`[duo] AUDIENCE: ${audience.persona}｜誤解: ${audience.misconception}`);

  const [corpusA, corpusB, series, producerSoul] = await Promise.all([
    loadCorpus(db, a.id), loadCorpus(db, b.id),
    loadSeriesContext(db, a, b, opts.taskId),
    loadProducerSoul(db),
  ]);
  console.log(`[duo] producer: ${producerSoul ? '無形製作人已進駐（玻璃後面）' : '角色不在，退回通用製作人'}`);
  const corpusOf = new Map<string, CorpusEntry[]>([[a.id, corpusA], [b.id, corpusB]]);
  console.log(`[duo] corpus: ${a.name}=${corpusA.length} 條, ${b.name}=${corpusB.length} 條`);
  if (series) console.log(`[duo] series: 這對角色之前錄過 ${series.episodeCount} 集，節目記憶已載入`);
  const briefOf = (id: string) => opts.briefs?.[id]?.trim() || undefined;
  if (opts.briefs && Object.keys(opts.briefs).length) {
    console.log(`[duo] briefs: ${characters.filter(c => briefOf(c.id)).map(c => c.name).join('、')} 有製作人私下交代`);
  }

  const [beliefA, beliefB, lexicon] = await Promise.all([
    generateBelief(bridgeCall, a, episodeGoal, corpusA, briefOf(a.id), series?.sharedBlock, series?.perChar.get(a.id)),
    generateBelief(bridgeCall, b, episodeGoal, corpusB, briefOf(b.id), series?.sharedBlock, series?.perChar.get(b.id)),
    loadLexicon(db),
  ]);
  console.log(`[duo] voice_lexicon 載入 ${lexicon.length} 條學習條目`);
  const beliefOf = new Map<string, BeliefState>([[a.id, beliefA], [b.id, beliefB]]);
  console.log(`[duo] belief ${a.name}: ${beliefA.coreClaim} / 軟肋: ${beliefA.weakestPoint.slice(0, 40)}`);
  console.log(`[duo] belief ${b.name}: ${beliefB.coreClaim} / 軟肋: ${beliefB.weakestPoint.slice(0, 40)}`);

  // 無形製作人前製協定：張力地圖＋五問法（fail-soft）
  const preProd = await designTensionMap(
    bridgeCall, producerSoul ?? '你是這集對話的製作人，負責前製設計。',
    episodeGoal, audience, characters, beliefOf, opts.focus,
  );
  if (preProd) {
    console.log(`[duo] 張力地圖 🔴: ${preProd.tensionMap.headOnCollision.slice(0, 60)}`);
    preProd.questions.forEach((q, i) => console.log(`[duo] 五問${i + 1}｜${q.intent}: ${q.q.slice(0, 50)}`));
  }
  const ammo = preProd
    ? preProd.questions.map((q, i) => `${i + 1}.（${q.intent}）${q.q}`).join('\n')
    : undefined;

  // ── 全場狀態 ─────────────────────────────────────────────────────────
  const turns: DuoTurn[] = [];
  const producerEvents: ProducerEvent[] = [];
  const history: HistoryLine[] = []; // 角色＋製作人混排（角色的對話脈絡）
  const deltas: BeliefDeltaRecord[] = [];
  const triggers = newTriggerState();
  const refocus: RefocusState = { consecutive: 0 };
  const lastTicOf = new Map<string, boolean>();
  let twoThingsCount = 0;
  let turnId = 0;

  const opponentOf = (c: DuoChar) => (c.id === a.id ? b : a);
  const speakerAt = (i: number) => (i % 2 === 0 ? a : b); // 純程式交替 = R6 結構性成立

  const pushProducer = async (action: Parameters<typeof produceUtterance>[2], context: string) => {
    const text = await produceUtterance(bridgeCall, episodeGoal, action, context, turns, producerSoul, ammo, opts.focus);
    if (!text) return;
    producerEvents.push({ afterTurnId: turnId - 1, action, utterance: text });
    history.push({ speaker: '製作人', text });
    console.log(`[duo] Producer ${action}: ${text.slice(0, 60)}`);
  };

  const runTurn = async (char: DuoChar, act: 1 | 2 | 3, actContext: string) => {
    const opponent = opponentOf(char);
    const belief = beliefOf.get(char.id)!;
    const corpus = corpusOf.get(char.id)!;
    const lastOppUtterance = [...turns].reverse().find(t => t.characterId === opponent.id)?.utterance ?? '';
    const prevEndsQ = turns.length > 0 ? turns[turns.length - 1].endsWithQuestion : false;

    // ── PASS 1 · THINK（想，不說；thought 只存 state，永不回灌 history）──
    let thought: Thought | null = null;
    let thinkVio: Violation[] = [];
    for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
      const t = await thinkTurn(
        bridgeCall, char, belief, corpus, opponent.name, episodeGoal, audience, briefOf(char.id), opts.focus,
        history, actContext, thinkVio,
      );
      if (!t) { thinkVio = []; continue; } // JSON 壞 → 重想，不 re-ask 修
      const vio = checkThink(t, turns.length === 0);
      if (turns.length > 0 && t.heard && !vio.some(v => v.rule === 'R1')) {
        const s = await checkSteelman(bridgeCall, t.heard, lastOppUtterance);
        if (s) vio.push(s);
      }
      thought = t;
      if (vio.length === 0) { thinkVio = []; break; }
      thinkVio = vio;
      console.log(`[duo] turn ${turnId} ${char.name} THINK 退回 ${vio.map(v => v.rule).join('/')}，嘗試 ${attempt + 1}/${MAX_REGEN + 1}`);
    }
    if (!thought) { console.warn(`[duo] turn ${turnId} ${char.name} THINK 全滅，跳過本輪`); return; }

    // ── PASS 2 · SPEAK（看不到欄位名稱與協議語言；退回=重新開口，不改寫（P4））──
    const evidence = corpus.filter(e => thought!.evidenceRefs.includes(e.id));
    let utterance = '';
    let speakVio: Violation[] = [];
    let retry: SpeakRetry | null = null;
    for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
      const raw = await speakTurn(
        bridgeCall, char, opponent.name, episodeGoal, opts.topic, belief, audience,
        history, actContext, thought, evidence, retry,
      );
      if (!raw) { retry = null; continue; }
      // Layer 1：確定性（R3/R5 + 協議洩漏種子 + 學習詞庫）——快，命中省一次 judge
      // 隱喻（舊 MOVE-2）與 AI 味已解禁：不進 vio、不觸發重講，收錄後純記錄（見 turn 組裝處）
      const vio = checkSpeak(raw, { prevEndsQ, twoThingsCount });
      const l1 = layer1Check(raw, lexicon);
      if (l1) vio.push(l1);
      // Layer 2：LLM judge（只在便宜層全過時跑；只管 MOVE-1／角色禁區）＋ R4 案例查證
      if (vio.length === 0) {
        const j = await layer2Judge(bridgeCall, raw, char.voice?.forbiddenRegister);
        if (j) {
          vio.push(j.violation);
          learnPhrase(db, j.span, j.category); // 自成長：Layer 2 命中＝Layer 1 漏掉
        }
        const e = await checkEvidence(bridgeCall, raw, thought.evidenceRefs, corpus);
        if (e) vio.push(e);
      }
      utterance = raw;
      if (vio.length === 0) { speakVio = []; break; }
      speakVio = vio;
      // 風格類（MOVE-1/REGISTER）砂紙只磨一遍：重講過一次後若只剩風格違規，帶 warnings 放行
      // ——退回壓力會讓角色過度自我審查，話開始像在躲地雷（2026-07-11「修過頭」教訓）
      const onlyStyle = vio.every(v => v.rule === 'MOVE1');
      if (onlyStyle && attempt >= 1) {
        console.log(`[duo] turn ${turnId} ${char.name} 風格違規已磨一遍，放行（${vio.map(v => v.rule).join('/')}）`);
        break;
      }
      const first = vio[0];
      retry = {
        offendingSpan: first.span ?? raw.slice(0, 40),
        why: `${first.rule}｜${first.detail}`,
        hint: first.rule === 'R4'
          ? '這一次，讓人聽得出來哪些是真的發生過、哪些是你想像的情境。'
          : '直接從內容開始講，不要先講你要做什麼。',
      };
      console.log(`[duo] turn ${turnId} ${char.name} SPEAK 退回 ${vio.map(v => v.rule).join('/')}，嘗試 ${attempt + 1}/${MAX_REGEN + 1}`);
    }
    if (!utterance) { console.warn(`[duo] turn ${turnId} ${char.name} SPEAK 全滅，跳過本輪`); return; }

    // 保底：連兩輪句首語氣詞 → 程式刪（安全操作，不算改寫）
    let filtered = utterance;
    const tic = detectLeadingTic(filtered);
    if (tic && lastTicOf.get(char.id)) filtered = stripLeadingTic(filtered);
    lastTicOf.set(char.id, !!tic);

    if (TWO_THINGS_RE.test(filtered)) twoThingsCount++;

    // 純記錄診斷（不阻擋、不重講）：隱喻用量＋AI 味——解禁後儀表要看得到，失控與否靠這個判斷
    const notes: string[] = [];
    const metaphor = diagnoseMetaphor(filtered);
    if (metaphor) notes.push(`NOTE-隱喻:「${metaphor}」`);
    for (const hit of scanText(filtered, opts.filterPatterns).slice(0, 2)) {
      notes.push(`NOTE-AI味:「${hit.matched}」`);
    }

    const turn: DuoTurn = {
      turnId,
      act,
      characterId: char.id,
      speaker: char.name,
      heard: thought.heard,
      stance: thought.stance,
      partialDetail: thought.partialDetail,
      concession: thought.cost,
      beliefDelta: thought.beliefDelta,
      intent: thought.intent,
      audienceResonance: thought.audienceResonance,
      utterance: filtered,
      evidenceRefs: thought.evidenceRefs,
      questionCount: countQuestions(filtered),
      endsWithQuestion: endsWithQuestion(filtered),
      ...(speakVio.length || notes.length
        ? { warnings: [...speakVio.map(v => `${v.rule}: ${v.detail.slice(0, 60)}`), ...notes] }
        : {}),
    };
    turns.push(turn);
    history.push({ speaker: char.name, text: filtered });
    if (turn.beliefDelta) {
      deltas.push({ characterId: char.id, speaker: char.name, turnId, delta: turn.beliefDelta });
      console.log(`[duo] 立場位移！${char.name} 第 ${turnId} 輪：${turn.beliefDelta.slice(0, 60)}`);
    }
    turnId++;

    // 確定性觸發器（假讓步×3／句長崩塌）
    const trig = detectTrigger(triggers, turns);
    if (trig) await pushProducer(trig, trig === 'CUT' ? '他們在假讓步或對聯化，把剛剛的內容壓成一句話逼他們確認' : '');

    // REFOCUS 煞車（確定性）：連續兩輪「說給觀眾聽」→ 點名對方回應（無形製作人三必介入之三）
    if (detectAudienceEscape(refocus, filtered)) {
      await pushProducer('REFOCUS', `${char.name} 已經連續對著台下講了——把球交回兩人之間，點名${opponentOf(char).name}接剛剛那句話`);
    }
  };

  // ══ ACT 1 — 鎖定分歧 ═════════════════════════════════════════════════
  const budget = actBudgets(opts.wordCount);
  console.log(`[duo] 幕次預算（${opts.wordCount} 字）：${budget.act1}+${ACT1_EXT}/${budget.act2}+${ACT2_EXT}/${budget.act3}`);
  console.log('[duo] ═══ ACT 1 鎖定分歧 ═══');
  for (let i = 0; i < budget.act1; i++) {
    const ctx = i === 0
      ? `第一幕：把你們的分歧攤出來。你是開場的人——自然開聊、一兩句就進話題，然後亮出你真正的主張。${series ? '你們不是第一次同台，像老搭檔一樣接續，不用重新認識彼此。' : ''}`
      : '第一幕：把你們的分歧攤出來。聽清楚對方的主張，說清楚你不一樣的地方在哪。';
    await runTurn(speakerAt(i), 1, ctx);
  }
  let disagreement = await distillDisagreement(bridgeCall, episodeGoal, turns, characters, beliefOf, producerSoul, opts.focus);
  let [okA, okB] = await Promise.all([
    confirmDisagreement(bridgeCall, a, disagreement),
    confirmDisagreement(bridgeCall, b, disagreement),
  ]);
  if (!okA || !okB) {
    console.log('[duo] 分歧宣言未獲雙方確認，延長 2 輪');
    await pushProducer('CUT', `我聽到的分歧是「${disagreement}」但有人不點頭。逼他們把真正的分歧一句話說出來`);
    for (let i = 0; i < ACT1_EXT; i++) await runTurn(speakerAt(turnId), 1, '第一幕延長：製作人要你們把真正的分歧說清楚——你們到底在哪裡分開。');
    disagreement = await distillDisagreement(bridgeCall, episodeGoal, turns, characters, beliefOf, producerSoul, opts.focus);
    console.log('[duo] Producer 裁定分歧宣言（延長後不再問）');
  }
  console.log(`[duo] 分歧宣言：${disagreement}`);

  // ══ ACT 2 — 攻打軟肋（預算 6＋2）══════════════════════════════════════
  console.log('[duo] ═══ ACT 2 攻打軟肋 ═══');
  await pushProducer('ACT_OPEN',
    `宣告分歧「${disagreement}」成立，然後指定戰場：${a.name}，${b.name}的軟肋是「${beliefB.weakestPoint}」，打那裡；${b.name}，${a.name}的軟肋是「${beliefA.weakestPoint}」，打那裡。用真實素材打，不准捏案例`);
  const act2Start = deltas.length;
  for (let i = 0; i < budget.act2; i++) {
    await runTurn(speakerAt(turnId), 2,
      '第二幕：攻打對方的軟肋，守住（或誠實修正）你自己的。對方打中你的 WEAKEST_POINT 時，承認它，不得繞過。');
    if ((i + 1) % 3 === 0) {
      const scan = await llmTriggerScan(bridgeCall, episodeGoal, turns);
      if (scan?.gold) {
        const gt = turns.find(t => t.turnId === scan.gold!.turnId);
        if (gt && !gt.gold) {
          gt.gold = scan.gold.why;
          console.log(`[duo] ⭐ 金礦：第 ${gt.turnId} 輪（${scan.gold.why}）——標記不干涉，收斂台不可剪`);
        }
      }
      if (scan?.action) {
        const ctx = scan.action === 'BREAK_4TH_WALL'
          ? `${scan.hint}。台下坐著的是：${audience.persona}，他帶著誤解「${audience.misconception}」進來——要他們對著這個人講`
          : scan.hint;
        await pushProducer(scan.action, ctx);
      }
      if (scan?.action === 'LAND') break; // 答案已出現 → 提前進第三幕
    }
  }
  if (deltas.length === act2Start) {
    console.log('[duo] 第二幕零位移 → PRESS 強制點名＋延長 2 輪');
    await pushProducer('PRESS',
      `到現在沒有任何人移動過，這不是對話是各自表演。${a.name}的 WHAT_WOULD_CHANGE_ME 是「${beliefA.whatWouldChangeMe}」；${b.name}的是「${beliefB.whatWouldChangeMe}」。點名：對方剛剛講的有沒有碰到這個？碰到了就動`);
    for (let i = 0; i < ACT2_EXT; i++) {
      await runTurn(speakerAt(turnId), 2,
        '第二幕最後機會：製作人點名了你的 WHAT_WOULD_CHANGE_ME。誠實面對：對方的話碰到它了嗎？碰到了就動，沒碰到就說清楚差在哪。');
    }
    if (deltas.length === act2Start) console.warn('[duo] PRESS 後仍零位移——誠實記錄，交付物會現形');
  }

  // ══ ACT 3 — 落地（預算 4）════════════════════════════════════════════
  console.log('[duo] ═══ ACT 3 落地 ═══');
  await pushProducer('LAND',
    `第三幕，收。禁止新議題。要他們各自給：一個你們真的同意的點、一個你們談不攏的點（誠實保留，不做假共識）、一個聽的人今天帶得走的具體做法`);
  for (let i = 0; i < budget.act3; i++) {
    const isLast = i === budget.act3 - 1;
    await runTurn(speakerAt(turnId), 3,
      isLast
        ? '第三幕收尾：對話到這裡結束。用你自己的方式自然收掉，可以留一句話給對方或聽的人。不要制式感謝收聽、不要總結全部觀點、不要丟新問題。'
        : '第三幕：落地。不開新議題。回到具體——哪些做法你真的認了、哪裡你仍然不同意，說得讓聽的人用得上。');
  }

  // ── 收斂台（無形製作人後製）：儀器掃描 → 製作人裁決 → 角色重講 ──────
  let convergence: ConvergenceResult = { trims: 0, retakes: 0, filterHits: 0, epilogue: '' };
  try {
    convergence = await convergeScript(
      bridgeCall, producerSoul ?? '你是這集對話的製作人，負責後製收斂。',
      episodeGoal, audience, turns, characters, beliefOf, corpusOf,
      opts.filterPatterns, opts.topic, opts.focus,
    );
    console.log(`[duo] 收斂台：TRIM ${convergence.trims}｜RETAKE ${convergence.retakes}｜儀器命中 ${convergence.filterHits}`);
  } catch (err) {
    console.warn(`[duo] 收斂台失敗（原稿放行）: ${err instanceof Error ? err.message : err}`);
  }

  // ── 交付物（過不了就 throw，這集不算完成）——用收斂後的最終稿 ────────
  const metaBody = await generateEpisodeMeta(bridgeCall, episodeGoal, disagreement, turns, deltas, producerSoul, opts.focus);
  const meta: EpisodeMeta = {
    episodeGoal,
    disagreementStatement: disagreement,
    beliefDeltas: deltas,
    ...metaBody,
  };

  console.log(`[duo] 完成：${turns.length} 輪｜位移 ${deltas.length} 次｜Producer 介入 ${producerEvents.length} 次｜⭐ ${turns.filter(t => t.gold).length}｜「兩件事」句型 ${twoThingsCount} 次`);
  return {
    turns,
    producerEvents,
    beliefs: { [a.id]: beliefA, [b.id]: beliefB },
    audience,
    ...(series ? { seriesContext: series.sharedBlock } : {}),
    ...(preProd ? { tensionMap: preProd.tensionMap, collisionQuestions: preProd.questions } : {}),
    ...(convergence.epilogue ? { producerEpilogue: convergence.epilogue } : {}),
    convergence: { trims: convergence.trims, retakes: convergence.retakes, filterHits: convergence.filterHits },
    meta,
  };
}
