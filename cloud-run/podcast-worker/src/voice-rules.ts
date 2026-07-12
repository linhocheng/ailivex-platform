/**
 * PASS 3 · 偵測器（Voice Layer 規格書 v1 第 7 節）——不是改寫器
 *
 * Layer 1：正則＋詞庫（快、便宜、高精確度、低召回）。命中直接 FAIL，省一次 LLM。
 * Layer 2：LLM judge（慢、貴、高召回、可泛化）。只餵 MOVE 規則＋角色禁區，
 *          不餵詞表——它必須靠「動作」判斷，才抓得到新變體。
 * 自成長：Layer 2 抓到而 Layer 1 漏掉的 → 寫回 voice_lexicon。
 * ⚠️ 詞庫永遠不能取代 MOVE 規則本身（規則住在 SPEAK prompt 的動作層）。
 *
 * 2026-07-12 解禁（關係矩陣版）：MOVE-2（隱喻描述內在狀態）全面解除阻擋——
 * 感性表達不是病，是情感密碼；病是「沒有聽眾的抽象對撞」，那由 Producer 的
 * BREAK_4TH_WALL 治。MOVE-2 降級為 diagnoseMetaphor() 純記錄（進 warnings，
 * 不觸發重講）；judge 不再管比喻；詞庫 MOVE2 條目載入時忽略、不再學新的。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { type BridgeCall, DUO_MODEL, extractJson } from './duo-types.js';
import { type Violation, MOVE1_SEED_RE } from './validators.js';

/** MOVE-2 種子（比喻內在狀態的家族）——只做診斷記錄，不阻擋 */
export const MOVE2_SEED_RE = /(緊張|情緒|恐懼|焦慮|它|能量)[^。，]{0,6}(在)?(燒|炸|引爆|點燃)|能量|頻率|共振(?!腔)|張力|(沒有|找不到)出口|流向|灌進|堵住|疏通|把[^。，]{0,8}接住|承接(?!辦)|黑箱|迴路|(不在)?同一(層|個樓層)|意義層|技術層/;

export interface LexiconEntry {
  phrase: string;
  category: 'MOVE1' | 'MOVE2' | 'REGISTER';
}

/** 開機載入詞庫。MOVE2 類條目忽略（隱喻已解禁，留在 DB 當史料不刪）。 */
export async function loadLexicon(db: Firestore): Promise<LexiconEntry[]> {
  try {
    const snap = await db.collection('voice_lexicon').get();
    return snap.docs
      .map(d => d.data() as LexiconEntry)
      .filter(e => e.phrase?.trim() && (e.category === 'MOVE1' || e.category === 'REGISTER'));
  } catch {
    return [];
  }
}

/** Layer 1：種子正則＋學習詞庫（MOVE1/REGISTER）。命中回 Violation，省一次 judge。 */
export function layer1Check(utterance: string, lexicon: LexiconEntry[]): Violation | null {
  const m1 = utterance.match(MOVE1_SEED_RE);
  if (m1) {
    return { rule: 'MOVE1', span: m1[0], detail: '你在報告你的對話動作，不是在說話。真人做，不報。直接從「聽到之後」開始講。' };
  }
  for (const e of lexicon) {
    if (e.phrase && utterance.includes(e.phrase)) {
      return { rule: 'MOVE1', span: e.phrase, detail: '你在報告你的對話動作。真人做，不報。' };
    }
  }
  return null;
}

/** MOVE-2 診斷（純記錄）：隱喻不再是病，但儀表要看得到用量——解禁後失控與否，靠這個判斷 */
export function diagnoseMetaphor(utterance: string): string | null {
  const m = utterance.match(MOVE2_SEED_RE);
  return m ? m[0] : null;
}

/** Layer 2：LLM judge。只餵規則不餵詞表；判定權在 code。 */
export async function layer2Judge(
  bridgeCall: BridgeCall,
  utterance: string,
  forbiddenRegister: string | undefined,
): Promise<{ violation: Violation; span: string; category: LexiconEntry['category'] } | null> {
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      `你檢查一句對話台詞有沒有兩種病。用「動作」判斷，不是用詞表。

MOVE-1｜報告對話動作：說話者在描述「我此刻在這場對話裡做什麼」——宣告同意或不同意、宣告要反駁或追問、宣告分歧是什麼、宣告這是重點、宣告要帶走什麼、複述對方的話再表態。真人直接說內容，不先報告動作。注意：講述自己過去的經歷、真誠的提問、直接陳述觀點、對台下聽眾直接說話都不是病。
${forbiddenRegister ? `\nREGISTER｜這個角色的專屬禁區：${forbiddenRegister}` : ''}

判準（重要）：只有「明確的病」才 fail——整句的重心就是在報告動作。以下都算 pass：偶發而自然的口語表態（一句帶過的同意或不同意）、引用對方原話再往下挖、講自己親身經歷、感性的比喻和情緒表達（那不是病，是人味）。拿不準就 pass——寧可放過，不要把人話磨成假話。

只輸出純JSON：{"pass":true} 或 {"pass":false,"move":"MOVE1|REGISTER","span":"命中的原文片段（≤20字）","why":"≤20字"}`,
      utterance,
      120,
    );
    const p = extractJson<{ pass?: boolean; move?: string; span?: string; why?: string }>(raw);
    if (!p || p.pass !== false || !p.span?.trim()) return null;
    if (p.move === 'MOVE2') return null; // 判準已不含 MOVE-2；模型仍回報時視為 pass（隱喻已解禁）
    const category: LexiconEntry['category'] = p.move === 'REGISTER' ? 'REGISTER' : 'MOVE1';
    const detail = category === 'REGISTER'
      ? `「${p.span}」踩進了你的禁區（${p.why ?? ''}）。用你自己的說法重講。`
      : `「${p.span}」是在報告你的對話動作（${p.why ?? ''}）。真人做，不報——直接從內容開始講。`;
    return {
      violation: { rule: 'MOVE1', span: p.span.trim(), detail },
      span: p.span.trim().slice(0, 30),
      category,
    };
  } catch {
    return null; // judge 掛了 fail-open，驗收指標會現形
  }
}

/** 自成長：Layer 2 命中而 Layer 1 漏掉 → 寫回詞庫（冪等：phrase 當 docId hash） */
export function learnPhrase(db: Firestore, span: string, category: LexiconEntry['category']): void {
  const phrase = span.trim().slice(0, 30);
  if (phrase.length < 2) return;
  const docId = Buffer.from(phrase).toString('base64url').slice(0, 60);
  db.collection('voice_lexicon').doc(docId).set({
    phrase,
    category,
    source: 'learned',
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true }).then(() => {
    console.log(`[voice-lexicon] 學到新條目 [${category}]「${phrase}」`);
  }).catch(err => {
    console.warn(`[voice-lexicon] 寫回失敗: ${err instanceof Error ? err.message : err}`);
  });
}
