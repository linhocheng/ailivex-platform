/**
 * 無形製作人（The Invisible Architect）— 召喚模組
 *
 * Producer 的 persona 不再寫死在 code：活讀 characters 集合裡的「無形製作人」
 * 角色 soul（admin 可改，改了下一集就生效）。找不到角色時退回通用製作人，
 * 錄音不因角色被改名而死。
 *
 * 三段能力：
 *   前製 — 張力地圖（三區）＋五問法碰撞問題（存 task doc 可稽核）
 *   現場 — 金礦標記（⭐ 不干涉只標記）＋ REFOCUS 煞車（說給觀眾聽→點名對方）
 *   後製 — 收斂台：儀器掃描（程式 scanText）→ 製作人裁決（KEEP/TRIM/RETAKE）
 *          → 角色重講（聲音永遠回到角色嘴裡）＋ 製作人後記
 *
 * 權限鐵律（P4 家族）：他有剪接權沒有改寫權——TRIM 必須是「整句刪除」的子集，
 * 程式驗證，驗不過就降級成 RETAKE（安全路徑）；⭐ 金礦程式硬保護，不靠他自律。
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type BridgeCall, type DuoChar, type DuoTurn, type BeliefState, type CorpusEntry,
  type AudienceMirror, type TensionMap, type CollisionQuestion,
  DUO_MODEL, extractJson, stripModelTokens,
} from './duo-types.js';
import { speakTurn, type HistoryLine, type Thought } from './protocol.js';
import { scanText } from './text-filter.js';

// ── 靈魂載入 ───────────────────────────────────────────────────────────

export async function loadProducerSoul(db: Firestore): Promise<string | null> {
  try {
    const snap = await db.collection('characters')
      .where('name', '==', '無形製作人')
      .where('status', '==', 'active')
      .limit(1)
      .get();
    const soul = snap.docs[0]?.data()?.soul as string | undefined;
    return soul?.trim() || null;
  } catch (err) {
    console.warn(`[duo] 無形製作人載入失敗（退回通用製作人）: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── 前製：張力地圖＋五問法 ─────────────────────────────────────────────

export interface PreProduction {
  tensionMap: TensionMap;
  questions: CollisionQuestion[];
}

export async function designTensionMap(
  bridgeCall: BridgeCall,
  soul: string,
  episodeGoal: string,
  audience: AudienceMirror | null,
  chars: DuoChar[],
  beliefs: Map<string, BeliefState>,
  focus?: string,
): Promise<PreProduction | null> {
  const guestBlock = chars.map(c => {
    const b = beliefs.get(c.id)!;
    const v = c.voice;
    return `【${c.name}】
核心主張：${b.coreClaim}
軟肋：${b.weakestPoint}
會被什麼說服：${b.whatWouldChangeMe}
語言紋路：${v ? [v.rhythm, v.habits, v.evidenceStyle].filter(Boolean).join('；') : '（未填）'}`;
  }).join('\n\n');

  const system = `${soul}

——以上是你的存在。現在執行你的前製協定。這一集要回答：「${episodeGoal}」
${audience ? `這集做給「${audience.persona}」這種人聽（他常帶著誤解「${audience.misconception}」）——受眾是羅盤不是在場者，問題不要設計成對他喊話。` : '這是一集開放議題，沒有指定受眾。'}${focus?.trim() ? `\n節目擁有者交代的焦點（五問裡至少一題要通向它）：「${focus.trim()}」` : ''}`;

  const user = `兩位來賓的靈魂解構材料：

${guestBlock}

執行：
1. 張力地圖三區——每區一句話，具體到這兩個人，不要通用套話。
2. 五道碰撞問題——依你的分層結構（共同起點→第一道張力→正面碰撞→意外扭轉→整合收尾）。標準：兩人都無法用慣用答案閃過、答案必定不同且差異有料。

只輸出純JSON：
{"tensionMap":{"surpriseResonance":"...","headOnCollision":"...","languageGap":"..."},"questions":[{"q":"...","intent":"共同起點"},{"q":"...","intent":"第一道張力"},{"q":"...","intent":"正面碰撞"},{"q":"...","intent":"意外扭轉"},{"q":"...","intent":"整合收尾"}]}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await bridgeCall(DUO_MODEL, system, user, 800, 180_000);
    const p = extractJson<PreProduction>(raw);
    if (p?.tensionMap?.headOnCollision?.trim() && Array.isArray(p.questions) && p.questions.filter(q => q?.q?.trim()).length >= 5) {
      return {
        tensionMap: {
          surpriseResonance: p.tensionMap.surpriseResonance?.trim() ?? '',
          headOnCollision: p.tensionMap.headOnCollision.trim(),
          languageGap: p.tensionMap.languageGap?.trim() ?? '',
        },
        questions: p.questions.filter(q => q?.q?.trim()).slice(0, 5).map(q => ({ q: q.q.trim(), intent: (q.intent ?? '').trim() })),
      };
    }
    console.warn(`[duo] 張力地圖第 ${attempt + 1} 次生成不合格，重生成`);
  }
  console.warn('[duo] 張力地圖生成失敗——本集無前製地圖（fail-soft，不擋錄音）');
  return null;
}

// ── 現場：REFOCUS 煞車（確定性）──────────────────────────────────────

/** 「說給觀眾聽」偵測（與 analyze-voice 同家族）——連續兩輪對台下直說 → 點名對方 */
export const AUDIENCE_ADDR_RE = /台下|聽眾|(在|正在)聽的(人|你)|螢幕(前|外)的|聽到這裡的你/;

export interface RefocusState { consecutive: number }

export function detectAudienceEscape(state: RefocusState, utterance: string): boolean {
  if (AUDIENCE_ADDR_RE.test(utterance)) {
    state.consecutive++;
    if (state.consecutive >= 2) {
      state.consecutive = 0; // 喊過歸零，避免每輪都喊
      return true;
    }
  } else {
    state.consecutive = 0;
  }
  return false;
}

// ── 後製：收斂台 ───────────────────────────────────────────────────────

interface Verdict {
  turnId: number;
  action: 'KEEP' | 'TRIM' | 'RETAKE';
  drop?: number[];   // TRIM：要刪的句子編號（結構上不可能越權——他只能選，不能寫）
  note?: string;
}

const MAX_RETAKES = 3;

/** 句子切分（渲染與套用共用同一把刀，保證編號對得上）。
 *  閉合符號（」』）⋯）回黏前段——否則 TRIM 剪掉後段會留下孤兒引號。 */
export function splitSegments(text: string): string[] {
  const raw = text.split(/(?<=[。！？!?…\n])/).filter(s => s.length > 0);
  const segs: string[] = [];
  for (const s of raw) {
    const m = s.match(/^([」』）)"'”\]]+)([\s\S]*)$/);
    if (m && segs.length) {
      segs[segs.length - 1] += m[1];
      if (m[2].length > 0) segs.push(m[2]);
    } else {
      segs.push(s);
    }
  }
  return segs;
}

/** 依編號刪句（剪接權的結構性實作：程式刪，製作人只給編號） */
export function applyDrop(text: string, drop: number[]): string | null {
  const segs = splitSegments(text);
  const dropSet = new Set(drop.filter(i => Number.isInteger(i) && i >= 0 && i < segs.length));
  if (dropSet.size === 0) return null;
  const kept = segs.filter((_, i) => !dropSet.has(i));
  const result = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (!result) return null;                          // 全刪＝越權
  if (result.length < text.trim().length * 0.25) return null; // 刪超過 75%＝那不是剪接是重寫，走 RETAKE
  return result;
}

export interface ConvergenceResult {
  trims: number;
  retakes: number;
  filterHits: number;
  epilogue: string;
}

/**
 * 收斂台：儀器掃描 → 製作人裁決 → 角色重講。
 * turns 的 utterance 就地更新，動過的輪次留 originalUtterance（真相鏈）。
 */
export async function convergeScript(
  bridgeCall: BridgeCall,
  producerSoul: string,
  episodeGoal: string,
  audience: AudienceMirror | null,
  turns: DuoTurn[],
  chars: DuoChar[],
  beliefs: Map<string, BeliefState>,
  corpusOf: Map<string, CorpusEntry[]>,
  filterPatterns: Array<{ id: string; re: RegExp }>,
  topic: string | undefined,
  focus?: string,
): Promise<ConvergenceResult> {
  // Step A｜儀器掃描（程式，確定性）——命中清單給製作人裁決，儀器不裁決
  const hitsOf = new Map<number, string[]>();
  for (const t of turns) {
    const hits = scanText(t.utterance, filterPatterns).map(h => h.matched);
    if (hits.length) hitsOf.set(t.turnId, hits);
  }
  const filterHits = [...hitsOf.values()].reduce((s, h) => s + h.length, 0);

  // Step B｜製作人裁決——台詞逐句編號，TRIM 只回編號（他只能選，不能寫）
  const transcript = turns.map(t => {
    const segs = splitSegments(t.utterance)
      .map((s, i) => (s.trim() ? `  s${i}｜${s.trim()}` : null))
      .filter(Boolean)
      .join('\n');
    return `[第${t.turnId}輪｜${t.speaker}${t.gold ? '｜⭐金礦' : ''}${hitsOf.has(t.turnId) ? `｜儀器命中:${hitsOf.get(t.turnId)!.join('、')}` : ''}]
${segs}`;
  }).join('\n\n');

  const system = `${producerSoul}

——以上是你的存在。現在執行你的後製翻譯協定。這一集要回答：「${episodeGoal}」
${audience ? `這集做給「${audience.persona}」這種人聽（羅盤，不在現場）。` : '這是一集開放議題。'}${focus?.trim() ? `節目擁有者交代的焦點：「${focus.trim()}」——確認最終稿真的談到了它；沒談到的話，在 RETAKE 的 note 裡把它要回來。` : ''}

你面前是剛殺青的逐字稿。你的工作：讓它呼吸——保留金礦，刪除冗余，保持兩人聲音區別。

翻譯前的三個自我審問，每一輪都要過：
① 這段話，如果是他自己寫的，他會用什麼詞？
② 這個洞見，符合他的第一性原理嗎？
③ 讀完這段，認識他的人，會說「這就是他說話的方式」嗎？

你的權限（鐵律）：
- KEEP：不動。
- TRIM：只能刪整句——每一輪的台詞已逐句編號（s0、s1⋯），你回報要刪的編號。你只能選，不能寫。刪掉冗余的解釋、重複的鋪墊、削弱力道的尾巴。
- RETAKE：這一輪需要重講。附一句 note（≤40字）告訴那個角色哪裡不對——他會用自己的聲音重講，你不會替他寫。整場最多 ${MAX_RETAKES} 輪 RETAKE，用在刀口上。
- ⭐金礦 標記的輪次：只能 KEEP。
- 特別注意：兩個人用了同款句式（尤其是同款的懺悔、同款的轉折）時，其中一輪要動——並排看得見機器，觀眾就出戲了。
- 儀器命中的句子：那是 AI 味偵測，你裁決——真的病就把那幾句 TRIM 掉或 RETAKE，誤傷就 KEEP。`;

  const user = `逐字稿（逐句編號）：

${transcript}

對每一輪給裁決。只輸出純JSON陣列（每輪一項，不可遺漏；drop 填該輪要刪的句子編號數字）：
[{"turnId":0,"action":"KEEP"},{"turnId":1,"action":"TRIM","drop":[2,5]},{"turnId":2,"action":"RETAKE","note":"..."}]`;

  let verdicts: Verdict[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await bridgeCall(DUO_MODEL, system, user, 1200, 240_000); // 全稿裁決是最重的一刀，給足時間
    const parsed = parseVerdictArray(raw); // 陣列輸出的確定性解析（壞了重生成，不 re-ask 修）
    if (parsed && parsed.length >= turns.length * 0.8) { verdicts = parsed; break; }
    console.warn(`[duo] 收斂裁決第 ${attempt + 1} 次解析失敗，重生成`);
  }
  if (!verdicts) {
    console.warn('[duo] 收斂台裁決失敗——本集不收斂（fail-soft，原稿放行）');
    return { trims: 0, retakes: 0, filterHits, epilogue: '' };
  }

  const byId = new Map(verdicts.map(v => [v.turnId, v]));
  let trims = 0, retakes = 0;

  for (const t of turns) {
    const v = byId.get(t.turnId);
    if (!v || v.action === 'KEEP') continue;
    if (t.gold) { console.log(`[duo] 收斂：第 ${t.turnId} 輪是 ⭐ 金礦，製作人裁決 ${v.action} 被程式否決`); continue; }

    if (v.action === 'TRIM') {
      const trimmed = Array.isArray(v.drop) ? applyDrop(t.utterance, v.drop) : null;
      if (trimmed) {
        t.originalUtterance = t.utterance;
        t.utterance = trimmed;
        trims++;
        console.log(`[duo] 收斂：第 ${t.turnId} 輪 TRIM（${t.originalUtterance.length}→${t.utterance.length} 字，刪 s${v.drop!.join(',s')}）`);
        continue;
      }
      console.log(`[duo] 收斂：第 ${t.turnId} 輪 TRIM 無效（編號不合法或刪過頭）→ 降級 RETAKE`);
      v.action = 'RETAKE';
      v.note = v.note || '這一輪太長，收緊——只講最有力的那一件事';
    }

    if (v.action === 'RETAKE' && retakes < MAX_RETAKES) {
      const char = chars.find(c => c.id === t.characterId)!;
      const history: HistoryLine[] = turns.filter(x => x.turnId < t.turnId).map(x => ({ speaker: x.speaker, text: x.utterance }));
      const thought: Thought = {
        heard: t.heard, stance: t.stance, partialDetail: t.partialDetail,
        cost: t.concession ?? null, intent: t.intent ?? '把這一輪講得更像自己',
        evidenceRefs: t.evidenceRefs, beliefDelta: t.beliefDelta ?? null,
        audienceResonance: t.audienceResonance ?? null,
      };
      const evidence = (corpusOf.get(t.characterId) ?? []).filter(e => t.evidenceRefs.includes(e.id));
      const opponent = chars.find(c => c.id !== t.characterId)!;
      try {
        const redo = await speakTurn(
          bridgeCall, char, opponent.name, episodeGoal, topic,
          beliefs.get(t.characterId)!, audience, history,
          '（後製重錄：這一輪重講，對話的其他部分不變。）', thought, evidence,
          { offendingSpan: t.utterance.slice(0, 40), why: `製作人的 note：${v.note ?? '重講這一輪'}`, hint: '不要修原句——重新開口，講你真正想說的那一件事。' },
        );
        if (redo?.trim()) {
          t.originalUtterance = t.utterance;
          t.utterance = redo.trim().replace(/\\n/g, '\n');
          retakes++;
          console.log(`[duo] 收斂：第 ${t.turnId} 輪 RETAKE（note: ${v.note?.slice(0, 40) ?? '—'}）`);
        }
      } catch (err) {
        console.warn(`[duo] 收斂：第 ${t.turnId} 輪 RETAKE 失敗，保留原文: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Step D｜製作人後記：「這場對話真正說了什麼」
  let epilogue = '';
  try {
    const finalTranscript = turns.map(t => `[${t.speaker}]: ${t.utterance}`).join('\n');
    epilogue = (await bridgeCall(
      DUO_MODEL,
      `${producerSoul}

——以上是你的存在。節目殺青了。這一集要回答：「${episodeGoal}」${audience ? `，做給「${audience.persona}」這種人聽` : ''}。`,
      `最終稿：

${finalTranscript}

寫你的後記——「這場對話真正說了什麼」。一篇只有玻璃後面的你能寫的東西：不重複他們的話、不總結 takeaway、寫你在玻璃後面看見而他們自己沒看見的。150 字以內，不加標題。`,
      400,
      120_000,
    ));
    epilogue = stripModelTokens(epilogue);
  } catch { /* 後記缺了不擋交付 */ }

  return { trims, retakes, filterHits, epilogue };
}

/** 裁決陣列的確定性解析（extractJson 只取大括號，陣列輸出走這裡） */
function parseVerdictArray(raw: string): Verdict[] | null {
  const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(s.slice(a, b + 1)) as Verdict[];
    if (!Array.isArray(arr)) return null;
    return arr.filter(v => typeof v?.turnId === 'number' && ['KEEP', 'TRIM', 'RETAKE'].includes(v?.action));
  } catch {
    return null;
  }
}
