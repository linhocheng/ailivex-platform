/**
 * 雙人對話系統（duo）共用型別 — 規格書 v1
 *
 * 診斷一句話：反駁免費、聆聽無報酬、對話無終點 → 角色理性地選擇了無限反駁。
 * 修法：聆聽變成可稽核的前置動作（heard）、反駁必須付立場修正（concession）、
 * 全場有交付物和有權喊停的人（Producer）。
 */

/** persona.voice — 正向描述這個角色說話的樣子（P5：LLM 對「不要想大象」極度無能） */
export interface VoiceBlock {
  rhythm?: string;            // 句子長短、快慢、會不會講完
  habits?: string;            // 慣用開場、慣用結尾
  evidenceStyle?: string;     // 怎麼舉證：例子？數字？人名？
  whenUncertain?: string;     // 不知道的時候會怎樣
  forbiddenRegister?: string; // 角色專屬禁區（與全平台 MOVE 規則疊加）
}

export interface DuoChar {
  id: string;
  name: string;
  soul: string;
  soulCore?: string;
  voice?: VoiceBlock;
}

/** L2 靈魂層附加欄位 — 給對方靶心，讓「說服」真的可能發生 */
export interface BeliefState {
  coreClaim: string;        // 核心主張，≤25 字
  weakestPoint: string;     // 最沒把握的一點（對方有權攻打，不得閃躲）
  whatWouldChangeMe: string;// 什麼證據會讓我改變想法（要像一個實驗）
  outOfScope: string;       // 不談什麼（碰到直接說「這我不知道」）
}

/** L1 素材層 — 掛既有角色知識庫（knowledge_chunks），禁止即興捏造案例 */
export interface CorpusEntry {
  id: string;         // knowledge_chunks doc id
  title: string;      // 母文件標題
  excerpt: string;    // gist 或原文前段
  sectionRef: string; // 出處定位
  authority: string;  // canonical | paraphrase | derived
}

export type Stance = 'ACCEPT' | 'PARTIAL' | 'REJECT';

/** L3 協議層 Turn Schema — 內部欄位不進腳本，但必須生成、必須通過驗證 */
export interface DuoTurn {
  turnId: number;
  act: 1 | 2 | 3;
  characterId: string;
  speaker: string;
  // 內部欄位（PASS 1 THINK 產物，只存這裡，永不回灌 prompt history）
  heard: string;                 // 對方會點頭的重述，禁轉折詞
  stance: Stance;
  partialDetail?: string;
  concession?: { before: string; after: string } | null;
  beliefDelta?: string | null;   // 本輪立場位移；無變動為 null
  intent?: string;               // 這一輪要達成什麼（動詞開頭）
  // 對外欄位
  utterance: string;
  evidenceRefs: string[];
  // 程式算的（不信模型自報）
  questionCount: number;
  endsWithQuestion: boolean;
  // 驗證殘留（重生成用盡後仍未過的規則，誠實留痕）
  warnings?: string[];
}

export type ProducerAction = 'CUT' | 'GROUND' | 'AUDIT' | 'PRESS' | 'LAND' | 'ACT_OPEN';

export interface ProducerEvent {
  afterTurnId: number;     // 插在哪一輪之後（-1 = 開場前）
  action: ProducerAction;
  utterance: string;       // 不進成品腳本，但進後續輪次的對話脈絡
}

export interface BeliefDeltaRecord {
  characterId: string;
  speaker: string;
  turnId: number;
  delta: string;
}

/** L4 交付物 — 終止 = 交付物齊了，不是聊到沒話講 */
export interface EpisodeMeta {
  episodeGoal: string;
  disagreementStatement: string;
  beliefDeltas: BeliefDeltaRecord[];
  consensus: string[];             // 2 個
  preservedDisagreement: string;   // 1 個誠實保留的分歧＋為什麼談不攏
  takeaways: string[];             // 3 個，聽眾帶得走
}

export type BridgeCall = (model: string, system: string, user: string, maxTokens: number) => Promise<string>;

/** 全線 Sonnet（bridge 月費是平的，判斷品質拉滿；Adam 拍板 2026-07-11） */
export const DUO_MODEL = 'claude-sonnet-4-6';

/** 確定性 JSON 抽取：剝 code fence → 取最外層大括號 → parse。壞了回 null（呼叫端重生成，不 re-ask 模型修） */
export function extractJson<T>(raw: string): T | null {
  const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}
