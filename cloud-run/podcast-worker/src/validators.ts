/**
 * L3 協議層 Validator — think 層與 speak 層分開檢查（Voice Layer v1）
 *
 * think 層（R1 聆聽格式、R2 反駁計價、steelman）：檢查 Thought，退回重想。
 * speak 層（R3 問句衛生、R5 重複招式、協議洩漏種子、R4 案例）：檢查台詞，退回重講。
 * 天條分工：計數/格式 = 純程式；語意（steelman、案例偵測）= Sonnet 當 classifier，判定權在 code。
 * 退回=重新開口，不是改寫——改寫會留下縫，人讀得出來（P4）。
 * R6（輪替）由 acts.ts 程式交替結構性吸收。
 */
import {
  type CorpusEntry, type BridgeCall,
  DUO_MODEL, extractJson,
} from './duo-types.js';
import type { Thought } from './protocol.js';

export interface Violation {
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'MOVE1' | 'MOVE2';
  detail: string;      // 退回時注入的修正指令
  span?: string;       // 命中的原文片段
}

// ── 確定性偵測器 ───────────────────────────────────────────────────────

/** R5：「X 跟 Y 是兩件事」句型家族 */
export const TWO_THINGS_RE = /是兩(件事|回事)|是兩個(問題|層次|東西|概念|議題)|這是兩層|分屬兩個/;

/** 協議洩漏種子（MOVE-1 的 Layer 1 快取；規則本體在 SPEAK prompt 的動作層） */
export const MOVE1_SEED_RE = /(這個|這點|這比喻)?我(接|收下)[了]?[，,。—-]|我保留的是|這(一點|個)我(同意|認同)[。，]|我們的分歧(在|是)|我想(挑一個字|逼你|追問|問得更細)|今天(能)?帶走|這才是(重點|終點|關鍵)|假設一個情境|我要反駁(一個)?前提/;

const HEARD_PIVOT_RE = /但|不過|可是|然而|however/i;

export function countQuestions(text: string): number {
  return (text.match(/[？?]/g) ?? []).length;
}

export function endsWithQuestion(text: string): boolean {
  const t = text.trim();
  return /[？?]$/.test(t.replace(/[」』）)"']+$/, '').trim()) || /[？?]$/.test(t);
}

/** think 層：R1 聆聽格式 + R2 反駁計價（重想，不重講） */
export function checkThink(thought: Thought, isFirstTurn: boolean): Violation[] {
  const v: Violation[] = [];

  if (!isFirstTurn) {
    if (!thought.heard?.trim()) {
      v.push({ rule: 'R1', detail: 'HEARD 是空的。先用一句話重述對方剛剛的主張——重述不出來代表你沒在聽，就別急著想反駁。' });
    } else if (HEARD_PIVOT_RE.test(thought.heard)) {
      v.push({ rule: 'R1', detail: 'HEARD 裡不准出現「但／不過／可是」。重述就是重述，必須是對方看了會點頭的版本，轉折是你自己的事。' });
    }
  }

  if (thought.stance === 'REJECT') {
    if (!thought.cost || thought.cost.before === thought.cost.after) {
      v.push({ rule: 'R2', detail: '你要反駁，就必須先付出立場修正：COST 的 before 和 after 都要填，且兩者必須真的不同。付不出修正就不准反駁——改成 (a) 問一個你真的不知道答案的問題（stance 改 PARTIAL），或 (b) 往前推進不回頭（stance 改 ACCEPT）。' });
    }
  }
  if (thought.stance === 'PARTIAL' && !thought.partialDetail?.trim()) {
    v.push({ rule: 'R2', detail: 'STANCE 是 PARTIAL 就要說清楚：哪一部分接受（具體）、哪一部分不接受（具體）。' });
  }

  return v;
}

/**
 * speak 層：R3 問句衛生 + R5 重複招式 + 協議洩漏種子。退回=重新開口。
 */
export function checkSpeak(
  utterance: string,
  ctx: { prevEndsQ: boolean; twoThingsCount: number },
): Violation[] {
  const v: Violation[] = [];

  const qc = countQuestions(utterance);
  if (qc > 1) {
    v.push({ rule: 'R3', span: utterance.slice(0, 40), detail: `這一輪有 ${qc} 個問號。最多問一個問題——挑最重要的，其他改成陳述，或干脆不問。` });
  }
  if (endsWithQuestion(utterance) && ctx.prevEndsQ) {
    v.push({ rule: 'R3', span: utterance.slice(-30), detail: '上一輪已經以問號結尾了。這一次說完你的話，停住，不把球丟回去。' });
  }

  const twoThings = utterance.match(TWO_THINGS_RE);
  if (twoThings && ctx.twoThingsCount >= 3) {
    v.push({ rule: 'R5', span: twoThings[0], detail: '「X 跟 Y 是兩件事」這一招整場已經用了三次以上。不要再切分概念——往前走一步，或講一個具體的當下。' });
  }

  const leak = utterance.match(MOVE1_SEED_RE);
  if (leak) {
    v.push({ rule: 'MOVE1', span: leak[0], detail: '你在報告你的對話動作，不是在說話。真人做，不報。直接從「聽到之後」開始講，把對方的話當成你自己的起點，不打招呼。' });
  }

  return v;
}

// ── LLM classifier（Sonnet 判語意，code 判後果）───────────────────────

/** R1 Steelman Gate：heard 是否為對方上一輪主張的忠實重述（think 層） */
export async function checkSteelman(
  bridgeCall: BridgeCall,
  heard: string,
  opponentUtterance: string,
): Promise<Violation | null> {
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      '你檢查一句「重述」是否忠實於原話的主張：原說話者看了會不會點頭說「對，我是這個意思」。挑剔標準：曲解、窄化、稻草人化都算不忠實；措辭不同但主張一致算忠實。只輸出純JSON：{"faithful":true} 或 {"faithful":false,"why":"≤20字"}',
      `原話：${opponentUtterance}\n\n重述：${heard}`,
      80,
    );
    const p = extractJson<{ faithful?: boolean; why?: string }>(raw);
    if (p && p.faithful === false) {
      return { rule: 'R1', detail: `你的 HEARD 不是對方會點頭的版本（${p.why ?? '曲解了原意'}）。重新聽一次對方剛剛說的，忠實重述。` };
    }
    return null;
  } catch {
    return null; // classifier 掛了不擋流程（fail-open，驗收指標會現形）
  }
}

/** R4 禁止即興案例：聲稱真實案例 → 必須有 think 層選定的 corpus 條目背書（speak 層） */
export async function checkEvidence(
  bridgeCall: BridgeCall,
  utterance: string,
  evidenceRefs: string[],
  corpus: CorpusEntry[],
): Promise<Violation | null> {
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      '你偵測一段話裡有沒有「聲稱真實發生過的第三方案例」——說話者拿別人來背書：「我有一個學員⋯」「我帶過一個案子⋯」「去年有位客戶⋯」「我們團隊有個人⋯」。說話者自己的親身經歷不算（那是他的人生，不是借來的權威）；純觀點、原則、聽得出來是想像的情境也不算。只輸出純JSON：{"hasCase":true,"span":"命中的那幾個字"} 或 {"hasCase":false}',
      utterance,
      80,
    );
    const p = extractJson<{ hasCase?: boolean; span?: string }>(raw);
    if (!p?.hasCase) return null;

    const validIds = new Set(corpus.map(e => e.id));
    const allValid = evidenceRefs.length > 0 && evidenceRefs.every(r => validIds.has(r));
    if (allValid) return null;

    return {
      rule: 'R4',
      span: p.span,
      detail: corpus.length
        ? '你講了一個素材庫裡沒有的「真實案例」——捏造的案例是責任問題。重講：要嘛用你素材裡真實發生過的事（含它的具體細節），要嘛讓人聽得出來這是你想像的情境，用你自己的話。'
        : '你沒有任何真實案例可講——你的素材庫是空的。重講：讓人聽得出來這是你想像的情境，用你自己的話帶出來，不要講得像真的發生過。',
    };
  } catch {
    return null;
  }
}
