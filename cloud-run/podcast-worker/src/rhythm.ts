/**
 * 節奏記憶 — 跨輪次的重複偵測與行為統計（純程式，確定性）
 *
 * 個性住在「什麼時候做什麼」的偏好裡，不是「每次都做什麼」的印章裡。
 * 偏好歸靈魂，頻率歸這裡：
 *   - 逐輪：偵測口頭禪/複述式開場 → 產出本輪禁令（注入 prompt）+ 保底刪除
 *   - 殺青後：算全場行為統計 → 餵給角色自審當鏡子（模型不會數數，程式會）
 */

export interface CharRhythm {
  lastTic: string | null;        // 上一輪句首語氣詞
  ticTotal: number;
  echoStreak: number;            // 連續幾輪以複述/稱讚對方開場
  echoTotal: number;
  lastMoves: string[];           // 最近的接話動作
  turns: number;
}

export type RhythmState = Map<string, CharRhythm>;

export const MOVES = [
  '直接反駁，說出你不同意的點',
  '追問對方一個具體細節',
  '用一個比喻把話題帶到新的角度',
  '舉一個你自身的例子',
  '簡短回應一句，不展開',
  '把討論推進到還沒碰的面向',
  '堅持你剛才的立場，不讓步',
] as const;

export function newRhythmState(): RhythmState {
  return new Map();
}

function charState(state: RhythmState, charId: string): CharRhythm {
  let s = state.get(charId);
  if (!s) {
    s = { lastTic: null, ticTotal: 0, echoStreak: 0, echoTotal: 0, lastMoves: [], turns: 0 };
    state.set(charId, s);
  }
  return s;
}

/** 句首括號語氣詞：（呵呵呵）（哈哈）（笑）之類 */
export function detectLeadingTic(text: string): string | null {
  const m = text.match(/^[（(]([^）)]{1,6})[）)]/);
  return m ? m[0] : null;
}

/** 複述/稱讚式開場：以對方名字開頭，或前段出現「說得好/這我同意」類蓋章 */
export function isEchoOpening(text: string, otherNames: string[]): boolean {
  const head = text.slice(0, 18);
  if (otherNames.some(n => text.slice(0, n.length + 4).includes(n))) return true;
  return /說得(好|對|妙|準|非常好)|你說的|這我(同意|認同)|我(完全|深深)?(同意|認同)|問得(好|很好)/.test(head);
}

/** 生成前：依歷史產出本輪禁令（空陣列 = 無禁令） */
export function buildConstraints(state: RhythmState, charId: string, otherNames: string[]): string[] {
  const s = charState(state, charId);
  const out: string[] = [];
  if (s.lastTic) {
    out.push(`不要用${s.lastTic}這類語氣詞開頭——你上一輪剛用過，連用就假了`);
  }
  if (s.echoStreak >= 1) {
    out.push(`不要先複述或稱讚${otherNames.join('、')}的話再開口——直接說你自己的，你有你的立場`);
  }
  return out;
}

/** 生成後：登記這一輪的行為 */
export function recordLine(state: RhythmState, charId: string, text: string, otherNames: string[], move?: string): void {
  const s = charState(state, charId);
  s.turns++;
  const tic = detectLeadingTic(text);
  if (tic) s.ticTotal++;
  s.lastTic = tic;
  if (isEchoOpening(text, otherNames)) { s.echoStreak++; s.echoTotal++; }
  else s.echoStreak = 0;
  if (move) {
    s.lastMoves.push(move);
    if (s.lastMoves.length > 3) s.lastMoves.shift();
  }
}

/** 保底：禁令下了還是笑了 → 程式刪句首語氣詞（安全操作，不傷語意） */
export function stripLeadingTic(text: string): string {
  return text.replace(/^[（(][^）)]{1,6}[）)]\s*/, '');
}

/** 場控建議的動作若跟該角色最近動作重複 → 換一個沒用過的 */
export function vetoRepeatedMove(state: RhythmState, charId: string, suggested: string): string {
  const s = charState(state, charId);
  if (!s.lastMoves.slice(-2).includes(suggested)) return suggested;
  const fresh = MOVES.find(m => !s.lastMoves.includes(m));
  return fresh ?? suggested;
}

/** 殺青後：算單一角色的全場行為統計（餵自審的鏡子） */
export function computeStats(
  lines: Array<{ characterId: string; text: string }>,
  charId: string,
  otherNames: string[],
): { turns: number; ticCount: number; ticExamples: string[]; echoCount: number } {
  const mine = lines.filter(l => l.characterId === charId);
  const tics = mine.map(l => detectLeadingTic(l.text)).filter((t): t is string => t !== null);
  const echo = mine.filter(l => isEchoOpening(l.text, otherNames)).length;
  return {
    turns: mine.length,
    ticCount: tics.length,
    ticExamples: [...new Set(tics)].slice(0, 3),
    echoCount: echo,
  };
}
