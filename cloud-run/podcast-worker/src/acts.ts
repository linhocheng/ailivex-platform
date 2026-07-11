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
  type BeliefState, type BeliefDeltaRecord, type BridgeCall, type CorpusEntry, DUO_MODEL,
} from './duo-types.js';
import { loadCorpus, generateBelief } from './belief.js';
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
import { loadLexicon, layer1Check, layer2Judge, learnPhrase } from './voice-rules.js';

const ACT1_BUDGET = 4;
const ACT1_EXT = 2;
const ACT2_BUDGET = 6;
const ACT2_EXT = 2;
const ACT3_BUDGET = 4;
const MAX_REGEN = 2; // 每輪最多重生成次數（之後帶 warnings 放行，誠實留痕）

export interface DuoResult {
  turns: DuoTurn[];
  producerEvents: ProducerEvent[];
  beliefs: Record<string, BeliefState>;
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

export async function runDuoScript(
  db: Firestore,
  bridgeCall: BridgeCall,
  characters: DuoChar[],
  opts: {
    episodeGoal?: string;
    topic?: string;
    focus?: string;
    wordCount: number;
    filterPatterns: Array<{ id: string; re: RegExp }>;
  },
): Promise<DuoResult> {
  if (characters.length !== 2) throw new Error('duo 管線只收兩個角色');
  const [a, b] = characters;

  // ── 前置：目標＋素材庫＋立場狀態 ────────────────────────────────────
  const episodeGoal = opts.episodeGoal?.trim() || await sharpenGoal(bridgeCall, opts.topic, characters);
  console.log(`[duo] EPISODE_GOAL: ${episodeGoal}`);

  const [corpusA, corpusB] = await Promise.all([loadCorpus(db, a.id), loadCorpus(db, b.id)]);
  const corpusOf = new Map<string, CorpusEntry[]>([[a.id, corpusA], [b.id, corpusB]]);
  console.log(`[duo] corpus: ${a.name}=${corpusA.length} 條, ${b.name}=${corpusB.length} 條`);

  const [beliefA, beliefB, lexicon] = await Promise.all([
    generateBelief(bridgeCall, a, episodeGoal, corpusA),
    generateBelief(bridgeCall, b, episodeGoal, corpusB),
    loadLexicon(db),
  ]);
  console.log(`[duo] voice_lexicon 載入 ${lexicon.length} 條學習條目`);
  const beliefOf = new Map<string, BeliefState>([[a.id, beliefA], [b.id, beliefB]]);
  console.log(`[duo] belief ${a.name}: ${beliefA.coreClaim} / 軟肋: ${beliefA.weakestPoint.slice(0, 40)}`);
  console.log(`[duo] belief ${b.name}: ${beliefB.coreClaim} / 軟肋: ${beliefB.weakestPoint.slice(0, 40)}`);

  // ── 全場狀態 ─────────────────────────────────────────────────────────
  const turns: DuoTurn[] = [];
  const producerEvents: ProducerEvent[] = [];
  const history: HistoryLine[] = []; // 角色＋製作人混排（角色的對話脈絡）
  const deltas: BeliefDeltaRecord[] = [];
  const triggers = newTriggerState();
  const lastTicOf = new Map<string, boolean>();
  let twoThingsCount = 0;
  let turnId = 0;

  const opponentOf = (c: DuoChar) => (c.id === a.id ? b : a);
  const speakerAt = (i: number) => (i % 2 === 0 ? a : b); // 純程式交替 = R6 結構性成立

  const pushProducer = async (action: Parameters<typeof produceUtterance>[2], context: string) => {
    const text = await produceUtterance(bridgeCall, episodeGoal, action, context, turns);
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
        bridgeCall, char, belief, corpus, opponent.name, episodeGoal,
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
        bridgeCall, char, opponent.name, episodeGoal, opts.topic,
        history, actContext, thought, evidence, retry,
      );
      if (!raw) { retry = null; continue; }
      // Layer 1：確定性（R3/R5 + 協議洩漏/比喻種子 + 學習詞庫 + AI 味模式）——快，命中省一次 judge
      const vio = checkSpeak(raw, { prevEndsQ, twoThingsCount });
      const l1 = layer1Check(raw, lexicon);
      if (l1) vio.push(l1);
      const aiHits = scanText(raw, opts.filterPatterns);
      if (aiHits.length > 0) {
        vio.push({ rule: 'MOVE2', span: aiHits[0].matched, detail: `「${aiHits[0].matched}」是抽象的體感表達——這種感受背後一定有一個具體的事件或行為，直接說那件事。` });
      }
      // Layer 2：LLM judge（只在便宜層全過時跑；靠動作判斷抓新變體）＋ R4 案例查證
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
      const first = vio[0];
      retry = {
        offendingSpan: first.span ?? raw.slice(0, 40),
        why: `${first.rule}｜${first.detail}`,
        hint: first.rule === 'MOVE2' || first.rule === 'R4'
          ? '這一次，不要講那個狀態像什麼。講那個人當下在做什麼。'
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
      utterance: filtered,
      evidenceRefs: thought.evidenceRefs,
      questionCount: countQuestions(filtered),
      endsWithQuestion: endsWithQuestion(filtered),
      ...(speakVio.length ? { warnings: speakVio.map(v => `${v.rule}: ${v.detail.slice(0, 60)}`) } : {}),
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
  };

  // ══ ACT 1 — 鎖定分歧（預算 4＋2）══════════════════════════════════════
  console.log('[duo] ═══ ACT 1 鎖定分歧 ═══');
  for (let i = 0; i < ACT1_BUDGET; i++) {
    const ctx = i === 0
      ? '第一幕：把你們的分歧攤出來。你是開場的人——自然開聊、一兩句就進話題，然後亮出你真正的主張。'
      : '第一幕：把你們的分歧攤出來。聽清楚對方的主張，說清楚你不一樣的地方在哪。';
    await runTurn(speakerAt(i), 1, ctx);
  }
  let disagreement = await distillDisagreement(bridgeCall, episodeGoal, turns, characters, beliefOf);
  let [okA, okB] = await Promise.all([
    confirmDisagreement(bridgeCall, a, disagreement),
    confirmDisagreement(bridgeCall, b, disagreement),
  ]);
  if (!okA || !okB) {
    console.log('[duo] 分歧宣言未獲雙方確認，延長 2 輪');
    await pushProducer('CUT', `我聽到的分歧是「${disagreement}」但有人不點頭。逼他們把真正的分歧一句話說出來`);
    for (let i = 0; i < ACT1_EXT; i++) await runTurn(speakerAt(turnId), 1, '第一幕延長：製作人要你們把真正的分歧說清楚——你們到底在哪裡分開。');
    disagreement = await distillDisagreement(bridgeCall, episodeGoal, turns, characters, beliefOf);
    console.log('[duo] Producer 裁定分歧宣言（延長後不再問）');
  }
  console.log(`[duo] 分歧宣言：${disagreement}`);

  // ══ ACT 2 — 攻打軟肋（預算 6＋2）══════════════════════════════════════
  console.log('[duo] ═══ ACT 2 攻打軟肋 ═══');
  await pushProducer('ACT_OPEN',
    `宣告分歧「${disagreement}」成立，然後指定戰場：${a.name}，${b.name}的軟肋是「${beliefB.weakestPoint}」，打那裡；${b.name}，${a.name}的軟肋是「${beliefA.weakestPoint}」，打那裡。用真實素材打，不准捏案例`);
  const act2Start = deltas.length;
  for (let i = 0; i < ACT2_BUDGET; i++) {
    await runTurn(speakerAt(turnId), 2,
      '第二幕：攻打對方的軟肋，守住（或誠實修正）你自己的。對方打中你的 WEAKEST_POINT 時，承認它，不得繞過。');
    if ((i + 1) % 3 === 0) {
      const scan = await llmTriggerScan(bridgeCall, episodeGoal, turns);
      if (scan) await pushProducer(scan.action, scan.hint);
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
  for (let i = 0; i < ACT3_BUDGET; i++) {
    const isLast = i === ACT3_BUDGET - 1;
    await runTurn(speakerAt(turnId), 3,
      isLast
        ? '第三幕收尾：對話到這裡結束。用你自己的方式自然收掉，可以留一句話給對方或聽的人。不要制式感謝收聽、不要總結全部觀點、不要丟新問題。'
        : '第三幕：落地。不開新議題。回到具體——哪些做法你真的認了、哪裡你仍然不同意，說得讓聽的人用得上。');
  }

  // ── 交付物（過不了就 throw，這集不算完成）────────────────────────────
  const metaBody = await generateEpisodeMeta(bridgeCall, episodeGoal, disagreement, turns, deltas);
  const meta: EpisodeMeta = {
    episodeGoal,
    disagreementStatement: disagreement,
    beliefDeltas: deltas,
    ...metaBody,
  };

  console.log(`[duo] 完成：${turns.length} 輪｜位移 ${deltas.length} 次｜Producer 介入 ${producerEvents.length} 次｜「兩件事」句型 ${twoThingsCount} 次`);
  return {
    turns,
    producerEvents,
    beliefs: { [a.id]: beliefA, [b.id]: beliefB },
    meta,
  };
}
