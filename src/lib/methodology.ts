/**
 * 方法論（教練框架層）—— 一套完整招式：被選中 → 照步驟走完（2026-07-08）。
 *
 * 設計三原則：
 * 1. 不切塊：方法論是程序不是文本，只對 triggerDesc 嵌入（選招），steps 整套注入當前步。
 * 2. 狀態機在程式：進入/推進/退出由 [[METHOD_*]] 標記 + 確定性 parse 更新
 *    conversation.activeMethodology；LLM 只發信號，不管狀態（天條）。
 * 3. 進入權在角色：觸發匹配只是「遞招」，要不要出招由角色（LLM）依對話判斷——
 *    避免誤觸發把閒聊鎖進步驟機。
 *
 * 相容開關：character.methodologyCount 缺省/0 → 兩條路徑（選招/推進）都完全不走。
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  COL,
  type ActiveMethodologyState,
  type CharacterDoc,
  type MethodologyDoc,
  type MethodologyStep,
} from '@/lib/collections';
import { generateKnowledgeEmbedding, cosineSimilarity } from '@/lib/embeddings';

const TRIGGER_FLOOR = 0.70;  // 選招門檻：低於此不遞招（誤觸發比漏觸發傷；multilingual-002 實測觸發0.73/無關0.59-0.63）
const MAX_METHODOLOGIES = 50;
export const MAX_STEPS = 20;

export type MethodologyWithId = MethodologyDoc & { id: string };

/** admin 入庫用：steps 驗證＋order 重編（1-based）。格式不對回 null，route 回 400。 */
export function sanitizeSteps(raw: unknown): MethodologyStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) return null;
  const steps: MethodologyStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as { instruction?: string; exitCondition?: string };
    const instruction = typeof s?.instruction === 'string' ? s.instruction.trim() : '';
    if (!instruction) return null;
    steps.push({
      order: i + 1,
      instruction,
      ...(typeof s?.exitCondition === 'string' && s.exitCondition.trim()
        ? { exitCondition: s.exitCondition.trim() } : {}),
    });
  }
  return steps;
}

// ─── 讀 ──────────────────────────────────────────────────────────────────────

export async function loadActiveMethodologies(
  db: Firestore,
  characterId: string,
): Promise<MethodologyWithId[]> {
  const snap = await db.collection(COL.methodologies)
    .where('characterId', '==', characterId)
    .limit(MAX_METHODOLOGIES)
    .get();
  return snap.docs
    .map(d => ({ ...(d.data() as MethodologyDoc), id: d.id }))
    .filter(m => (m.status ?? 'active') === 'active');
}

/**
 * 組方法論塊。兩種形態：
 * - 有進行中的方法（activeM）→ 注入當前步驟＋推進/退出信號說明
 * - 沒有 → 用戶這句話對 triggerDesc 做語義匹配，夠高才「遞招」（要不要用由角色判斷）
 * 回傳 block（'' = 不注入）；有進行中方法時一併回傳它的完整定義供 route 做狀態推進驗證。
 */
export async function loadMethodologyBlock(
  db: Firestore,
  characterId: string,
  query: string,
  activeM: ActiveMethodologyState | null | undefined,
  char?: Pick<CharacterDoc, 'methodologyCount'>,
): Promise<{ block: string; active: MethodologyWithId | null }> {
  const empty = { block: '', active: null };
  if (!characterId) return empty;
  if (!char?.methodologyCount || char.methodologyCount <= 0) return empty;

  try {
    // ── 形態一：有進行中的方法 → 注入當前步 ─────────────────────────────────
    if (activeM?.id) {
      const snap = await db.collection(COL.methodologies).doc(activeM.id).get();
      if (snap.exists && ((snap.data() as MethodologyDoc).status ?? 'active') === 'active') {
        const m = { ...(snap.data() as MethodologyDoc), id: snap.id };
        const step = m.steps.find(s => s.order === activeM.step) ?? m.steps[activeM.step - 1];
        if (step) {
          const total = m.steps.length;
          return {
            block: `\n\n【進行中的引導方法：${m.name}（第 ${activeM.step}/${total} 步）】
這套方法的目的：${m.purpose}
你現在在第 ${activeM.step} 步：${step.instruction}${step.exitCondition ? `
這一步完成的判準：${step.exitCondition}` : ''}
（照這一步引導，不跳步、不自創流程，用你自己的語氣說。這一步真的完成了，回覆裡夾帶 [[METHOD_NEXT]] 進下一步${activeM.step >= total ? '——這是最後一步，完成就夾帶 [[METHOD_EXIT]] 收尾' : ''}；對方明顯不想繼續或話題已離開，夾帶 [[METHOD_EXIT]] 自然收掉，不要硬拉回來。標記不會顯示給對方。）`,
            active: m,
          };
        }
        // 步驟指標壞了（步驟被編輯刪短等）→ 回 active:null，
        // applyMethodologySignals 的「定義失效」分支會清掉狀態，對話不卡死
        return { block: '', active: null };
      }
      return empty; // 方法已刪/封存 → 不注入（route 會清狀態）
    }

    // ── 形態二：沒有進行中 → 選招（觸發匹配夠高才遞）───────────────────────
    if (!query?.trim()) return empty;
    const [qEmb, methodologies] = await Promise.all([
      generateKnowledgeEmbedding(query, 'query').catch(() => null),
      loadActiveMethodologies(db, characterId),
    ]);
    if (!qEmb || methodologies.length === 0) return empty;

    let best: { m: MethodologyWithId; score: number } | null = null;
    for (const m of methodologies) {
      if (!Array.isArray(m.triggerEmb) || m.triggerEmb.length === 0) continue;
      const score = cosineSimilarity(qEmb, m.triggerEmb);
      if (score >= TRIGGER_FLOOR && (!best || score > best.score)) best = { m, score };
    }
    if (!best) return empty;

    const m = best.m;
    return {
      block: `\n\n【你會的一套引導方法，現在可能用得上：${m.name}】
目的：${m.purpose}${m.preconditions.length > 0 ? `
使用前提：${m.preconditions.join('；')}` : ''}
（如果你判斷對方此刻真的需要被這樣帶——且前提成立——在回覆裡夾帶 [[METHOD_START id="${m.id}"]]，然後從第一步自然開始，不要宣布「我們來跑流程」。只是話題擦到邊、對方沒有求助的意思，就忽略這個提示，正常聊。標記不會顯示給對方。）`,
      active: null,
    };
  } catch (e) {
    console.error('[methodology] loadMethodologyBlock failed:', e instanceof Error ? e.message : String(e));
    return empty;
  }
}

// ─── 狀態機：依標記確定性推進（全程式，無 LLM）────────────────────────────────

export interface MethodologySignals {
  methodStart: string | null;  // [[METHOD_START id="..."]] 的 id
  methodNext: boolean;
  methodExit: boolean;
}

/**
 * 依這輪的信號更新 conversation.activeMethodology。
 * 驗證全在這：START 的 id 必須真的存在且屬於這個角色；NEXT 超過最後一步 = 完成 = 清空。
 */
export async function applyMethodologySignals(
  db: Firestore,
  userId: string,
  characterId: string,
  signals: MethodologySignals,
  activeM: ActiveMethodologyState | null | undefined,
  activeDef: MethodologyWithId | null,
): Promise<void> {
  const convRef = db.collection(COL.conversations).doc(`${userId}_${characterId}`);

  try {
    // 退出優先（同輪同時出現 NEXT+EXIT 時，EXIT 說了算）
    if (signals.methodExit && activeM?.id) {
      await convRef.update({ activeMethodology: null });
      console.info(`[methodology] exit: ${activeM.name} (${userId}×${characterId})`);
      return;
    }

    if (signals.methodNext && activeM?.id && activeDef) {
      const next = activeM.step + 1;
      if (next > activeDef.steps.length) {
        await convRef.update({ activeMethodology: null });
        console.info(`[methodology] completed: ${activeM.name} (${userId}×${characterId})`);
      } else {
        await convRef.update({ activeMethodology: { ...activeM, step: next } });
        console.info(`[methodology] advance: ${activeM.name} → step ${next}`);
      }
      return;
    }

    if (signals.methodStart && !activeM?.id) {
      const snap = await db.collection(COL.methodologies).doc(signals.methodStart).get();
      if (!snap.exists) return;
      const m = snap.data() as MethodologyDoc;
      if (m.characterId !== characterId || (m.status ?? 'active') !== 'active' || m.steps.length === 0) return;
      const state: ActiveMethodologyState = {
        id: signals.methodStart,
        name: m.name,
        step: 1,
        enteredAt: Date.now(),
      };
      await convRef.update({ activeMethodology: state }).catch(async e => {
        // conversation doc 可能還不存在（第一輪對話）→ set merge
        if ((e as { code?: number })?.code === 5) {
          await convRef.set({ userId, characterId, messages: [], messageCount: 0, updatedAt: new Date(), activeMethodology: state }, { merge: true });
        } else throw e;
      });
      console.info(`[methodology] start: ${m.name} (${userId}×${characterId})`);
      return;
    }

    // 進行中但定義已失效（被刪/封存/步驟指標壞）→ 清狀態，別讓對話卡死
    if (activeM?.id && !activeDef) {
      await convRef.update({ activeMethodology: null }).catch(() => {});
    }
  } catch (e) {
    console.error('[methodology] applyMethodologySignals failed:', e instanceof Error ? e.message : String(e));
  }
}
