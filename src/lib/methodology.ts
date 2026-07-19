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
import { parseJsonLoose } from '@/lib/safe-json';

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

// ─── 方法論共創（admin 對話提案 → draft → 審核轉正）──────────────────────────

/**
 * 只在「admin 對話 × 角色開了 methodProposalEnabled」時注入——
 * 教角色分清知識庫／方法論兩個公共器官，以及提案的格式鐵律。
 * 一般用戶對話永遠不帶這段，角色也就不會被用戶慫恿自改手法。
 */
export const METHOD_PROPOSE_INSTRUCTION = `
- 方法論共創（僅此對話開放）：對方是你的訓練師。先分清你的兩個公共器官——
  「知識庫」是你讀過的內容，回答「是什麼／為什麼」；用戶問到相關內容時，系統會自動讓相關段落浮現給你。
  「方法論」是你帶人的手法，回答「對方卡住了，怎麼一步步帶」；用戶陷入特定狀態時，系統會把合適的一套遞給你，由你判斷要不要出招。
  一段觀點或素材屬於知識庫（請訓練師到後台入庫即可），不要硬做成步驟。
  當你和訓練師把一套可反覆使用的引導方法聊成形（有名字、有步驟、有完成判準），或訓練師明確請你提出方法論時，在回覆中夾帶：
  [[PROPOSE_METHOD]]
  {"name":"方法名","purpose":"解決什麼問題","triggerDesc":"用戶會說出口的白話狀態描述","preconditions":["使用前提"],"steps":[{"instruction":"這一步帶對方做什麼","exitCondition":"怎麼判斷這一步完成了"}]}
  [[/PROPOSE_METHOD]]
  格式鐵律：
  triggerDesc 決定系統何時把這套遞給你——只寫這套獨有的狀態簽名＋用戶會說出口的白話（例：「說話繞圈、一直說自己沒有選擇」），不寫術語、不寫泛語，寫錯這套就永遠不會在對的時機出現。
  steps 三到七步：instruction 寫目標不寫台詞（台詞會被照念變木頭），exitCondition 要具體可判（「說得出具體最壞結果」而不是「他理解了」）。
  提案不會立即生效：訓練師在後台審核轉正後，才成為你對所有人的正式手法。標記不會顯示給對方，一般聊天不發。`;

/**
 * 共創語境用：角色現有 active 方法論清單塊。
 * 平常對話不注入（方法論是狀態觸發才遞，角色沒有庫存清單可背）；
 * 只在共創指令（admin×旗標）後面附上，訓練師問「你有哪些」才答得出。
 */
export function buildMethodInventoryNote(methods: MethodologyWithId[]): string {
  if (methods.length === 0) {
    return '\n  你目前還沒有任何正式方法論——這正是共創的起點，訓練師問起時如實說。';
  }
  return `\n  你現有的正式方法論（訓練師問起時照這份答；平常對用戶由系統在對的時機遞給你）：\n${
    methods.map(m => `  - 《${m.name}》：${m.purpose}`).join('\n')}`;
}

export type ProposalResult =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string };

/**
 * 收下角色的方法論提案：確定性 parse（parseJsonLoose，不 re-ask 模型修）→ 驗證 →
 * 嵌 triggerEmb → 落 status='draft'。draft 不動 methodologyCount（相容開關語意 = active 數），
 * 對一般用戶完全隱形；審核轉正走 admin methodologies route。
 */
export async function saveMethodologyProposal(
  db: Firestore,
  characterId: string,
  rawJson: string,
  proposedBy: string,
): Promise<ProposalResult> {
  const parsed = parseJsonLoose<Record<string, unknown>>(rawJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '提案內容不是可解析的 JSON' };
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const purpose = typeof parsed.purpose === 'string' ? parsed.purpose.trim() : '';
  const triggerDesc = typeof parsed.triggerDesc === 'string' ? parsed.triggerDesc.trim() : '';
  if (!name || !purpose || !triggerDesc) {
    return { ok: false, error: 'name / purpose / triggerDesc 缺漏' };
  }
  const steps = sanitizeSteps(parsed.steps);
  if (!steps) {
    return { ok: false, error: `steps 需為 1-${MAX_STEPS} 步、每步含 instruction` };
  }
  // 同名冪等：同角色已有同名（不論狀態）就不重複收，避免同一場對話反覆提案灌爆待審區
  const dup = await db.collection(COL.methodologies)
    .where('characterId', '==', characterId).where('name', '==', name).limit(1).get();
  if (!dup.empty) {
    return { ok: false, error: `已有同名方法論《${name}》（可能已提過或已在庫）` };
  }
  const triggerEmb = await generateKnowledgeEmbedding(triggerDesc, 'document').catch(() => null);
  const doc: MethodologyDoc = {
    characterId,
    name,
    purpose,
    triggerDesc,
    ...(triggerEmb ? { triggerEmb } : {}),
    preconditions: (Array.isArray(parsed.preconditions) ? parsed.preconditions : [])
      .filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim()),
    steps,
    status: 'draft',
    proposedBy,
    createdAt: new Date(),
  };
  const ref = await db.collection(COL.methodologies).add(doc);
  return { ok: true, id: ref.id, name };
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
