/**
 * 夜間鞏固管線 —— 記憶全景圖第二期（2026-07-07）。
 *
 * 像人睡覺時大腦做的事：把白天的情節（memories, fact/preference）消化成印象（impressions, 信念）。
 * 每晚對「有新情節的配對」跑一次：
 *   1. 撈 watermark 之後的新情節（oldest-first，每輪上限 40 條）
 *   2. LLM 判斷題：每條情節 → 支持既有印象 / 形成新印象 / 矛盾推翻 / 瑣事跳過
 *   3. 程式驗證後寫回：supportingEpisodes / 新印象 / supersededBy（永不硬刪）
 *   4. watermark 推進到最後處理的情節
 *
 * 分工守天條：聚合、驗證、寫入、watermark、confidence 全程式；LLM 只回「這條情節屬於哪種操作」。
 * 結構性優勢：情節只被消化一次（watermark），沒有 O(n²) 灰區配對問題，不需要裁決備忘錄。
 * LLM 輸出壞 → 該配對本輪跳過、watermark 不動、下輪重試——不 re-ask 模型修（天條）。
 *
 * 時間預算（bridge 實測冷 34s/暖 7.5s）：單配對一次 LLM call；總預算由 cron route 控。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { COL, type ImpressionDoc, type MemoryDoc, type RelationshipDoc } from '@/lib/collections';
import { generateEmbedding } from '@/lib/embeddings';
import { parseJsonLoose } from '@/lib/safe-json';
import { loadActiveImpressions, type ImpressionWithId } from '@/lib/impressions';
import { trackCost } from '@/lib/cost-tracker';

const CONSOLIDATION_MODEL = 'claude-sonnet-4-6'; // 形成信念的品質值得 Sonnet（bridge 吃到飽）
const MAX_EPISODES_PER_RUN = 40;
const CONSOLIDATABLE_TYPES = new Set(['fact', 'preference']);

type EpisodeWithId = MemoryDoc & { id: string };

type Op =
  | { episode: number; op: 'support'; impression: number }
  | { episode: number; op: 'new'; content: string; kind: 'fact' | 'preference' }
  | { episode: number; op: 'contradict'; impression: number; updated: string }
  | { episode: number; op: 'skip' };

type LLMClient = {
  messages: {
    create: (args: {
      model: string; max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>;
  };
};

export interface PairResult {
  userId: string;
  characterId: string;
  episodes: number;
  supported: number;
  created: number;
  superseded: number;
  skipped: number;
  status: 'done' | 'empty' | 'llm_error' | 'error';
  detail?: Array<Record<string, unknown>>;
}

function toMillis(t: unknown): number {
  if (!t) return 0;
  if (t instanceof Date) return t.getTime();
  const d = (t as { toDate?: () => Date }).toDate?.();
  return d ? d.getTime() : 0;
}

function relDays(t: unknown): string {
  const ms = toMillis(t);
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400_000);
  return days < 1 ? '今天' : `${days}天前`;
}

/** 對單一配對跑一輪鞏固。dryRun = 只回計畫不寫。 */
export async function consolidatePair(
  db: Firestore,
  userId: string,
  characterId: string,
  charName: string,
  client: LLMClient,
  opts: { dryRun?: boolean } = {},
): Promise<PairResult> {
  const dryRun = !!opts.dryRun;
  const base: PairResult = { userId, characterId, episodes: 0, supported: 0, created: 0, superseded: 0, skipped: 0, status: 'done' };

  try {
    const relRef = db.collection(COL.relationships).doc(`${userId}_${characterId}`);
    const relSnap = await relRef.get();
    const rel = relSnap.exists ? (relSnap.data() as RelationshipDoc) : null;
    const watermark = toMillis(rel?.consolidationWatermark);

    // 1. 撈新情節（watermark 之後，oldest-first）
    let q = db.collection(COL.memories)
      .where('userId', '==', userId)
      .where('characterId', '==', characterId)
      .orderBy('createdAt', 'asc')
      .limit(MAX_EPISODES_PER_RUN * 3); // 超取再過濾 type/tier（避免索引爆炸）
    if (watermark > 0) q = q.startAfter(Timestamp.fromMillis(watermark));
    const epSnap = await q.get();

    const episodes: EpisodeWithId[] = epSnap.docs
      .map(d => ({ ...(d.data() as MemoryDoc), id: d.id }))
      .filter(m => CONSOLIDATABLE_TYPES.has(m.type) && m.tier !== 'archive' && !m.consolidatedAt)
      .slice(0, MAX_EPISODES_PER_RUN);

    // watermark 推進基準：本批「掃過」的所有文件（含被 type 過濾掉的——它們不歸這條管線管）
    const scannedMax = epSnap.docs.length > 0
      ? Math.max(...epSnap.docs.map(d => toMillis((d.data() as MemoryDoc).createdAt)))
      : 0;
    // 若有超量（filter 後被 slice 截掉），watermark 只能推到最後一條「已處理」的情節
    const processedMax = episodes.length > 0
      ? toMillis(episodes[episodes.length - 1].createdAt)
      : scannedMax;
    const hadOverflow = epSnap.docs
      .map(d => ({ ...(d.data() as MemoryDoc), id: d.id }))
      .filter(m => CONSOLIDATABLE_TYPES.has(m.type) && m.tier !== 'archive' && !m.consolidatedAt)
      .length > MAX_EPISODES_PER_RUN;
    const newWatermark = hadOverflow ? processedMax : Math.max(scannedMax, processedMax);

    if (episodes.length === 0) {
      // 沒有可消化的，watermark 照推（掃過即消化完畢）
      if (!dryRun && newWatermark > watermark && relSnap.exists) {
        await relRef.update({ consolidationWatermark: Timestamp.fromMillis(newWatermark) });
      }
      return { ...base, status: 'empty' };
    }
    base.episodes = episodes.length;

    // 2. 既有印象 + LLM 判斷題
    const impressions = await loadActiveImpressions(db, userId, characterId);
    const impList = impressions.length > 0
      ? impressions.map((im, i) => `${i + 1}. ${im.content}（支持 ${im.supportingEpisodes.length} 次）`).join('\n')
      : '（還沒有任何印象）';
    const epList = episodes.map((e, i) => `${i + 1}. (${relDays(e.createdAt)}) [${e.type}] ${e.content}`).join('\n');

    const prompt = `你是「${charName}」的記憶整理員。深夜，你把最近的對話記憶消化成「對這個人的理解」。

既有印象（編號）：
${impList}

新的記憶片段（編號）：
${epList}

對每條新記憶判斷一個操作：
- 支持某條既有印象（同一件事的再次確認/補充）→ {"episode":N,"op":"support","impression":M}
- 形成新印象（值得長期理解的信念，一句話概括，不是事件流水帳）→ {"episode":N,"op":"new","content":"...","kind":"fact"或"preference"}
- 與既有印象矛盾（新資訊推翻舊理解，不能同時為真才算，判斷要保守）→ {"episode":N,"op":"contradict","impression":M,"updated":"更新後的信念"}
- 一次性瑣事，不構成對人的理解 → {"episode":N,"op":"skip"}

規則：
- 相近的記憶歸進同一條印象（用 support），不要開重複的新印象
- 同一批新記憶裡講同一件事的：第一條開 new，其餘 support 你剛開的那條（用它出現後的編號 ${impressions.length + 1} 起算）
- 印象句用「他⋯」開頭的第三人稱信念句
- 每條 episode 都要有一個操作

只回 JSON 陣列：
<result>
[{"episode":1,"op":"support","impression":2}, ...]
</result>`;

    const res = await client.messages.create({
      model: CONSOLIDATION_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    await trackCost(characterId, CONSOLIDATION_MODEL, res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0, 'consolidation', userId);

    const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    const match = text.match(/<result>([\s\S]*?)<\/result>/);
    const ops = match ? parseJsonLoose<Op[]>(match[1].trim()) : null;
    if (!Array.isArray(ops)) {
      console.warn(`[consolidation] LLM 輸出無法解析，配對跳過（watermark 不動）: ${userId}×${characterId}`);
      return { ...base, status: 'llm_error' };
    }

    // 3. 程式驗證 + 寫回。LLM 輸出當不可信文字：索引越界/enum 錯/內容空 → 該條當 skip。
    // 「本批新開的印象」LLM 用虛擬編號（既有數+1 起算）引用，程式映射到實際 doc。
    const detail: Array<Record<string, unknown>> = [];
    const newImpressionsByVirtualIdx = new Map<number, { ref: FirebaseFirestore.DocumentReference; doc: ImpressionDoc }>();
    let virtualIdx = impressions.length; // 下一個虛擬編號 - 1（0-based 邏輯）
    const now = new Date();
    const seenEpisodes = new Set<number>();

    const resolveImpression = (m: number): { ref: FirebaseFirestore.DocumentReference; existing?: ImpressionWithId } | null => {
      if (m >= 1 && m <= impressions.length) {
        return { ref: db.collection(COL.impressions).doc(impressions[m - 1].id), existing: impressions[m - 1] };
      }
      const virt = newImpressionsByVirtualIdx.get(m);
      return virt ? { ref: virt.ref } : null;
    };

    for (const op of ops) {
      const epIdx = (op as { episode?: unknown }).episode;
      if (typeof epIdx !== 'number' || epIdx < 1 || epIdx > episodes.length || seenEpisodes.has(epIdx)) continue;
      seenEpisodes.add(epIdx);
      const ep = episodes[epIdx - 1];
      const epRef = db.collection(COL.memories).doc(ep.id);

      if (op.op === 'support' && typeof op.impression === 'number') {
        const target = resolveImpression(op.impression);
        if (!target) {
          // 引用越界視同 skip：標 consolidatedAt（處理過），情節照常走 episodic 生命週期
          base.skipped++;
          detail.push({ ep: ep.content.slice(0, 40), op: 'skip(壞引用)' });
          if (!dryRun) await epRef.update({ consolidatedAt: now });
          continue;
        }
        base.supported++;
        detail.push({ ep: ep.content.slice(0, 40), op: `support→#${op.impression}` });
        if (!dryRun) {
          const { FieldValue } = await import('firebase-admin/firestore');
          await target.ref.update({ supportingEpisodes: FieldValue.arrayUnion(ep.id), lastReinforcedAt: now });
          await epRef.update({ consolidatedAt: now, consolidatedInto: target.ref.id });
        }

      } else if (op.op === 'new' && typeof op.content === 'string' && op.content.trim()) {
        const kind = op.kind === 'preference' ? 'preference' : 'fact';
        virtualIdx++;
        base.created++;
        detail.push({ ep: ep.content.slice(0, 40), op: `new#${virtualIdx}`, content: op.content.trim().slice(0, 60) });
        const ref = db.collection(COL.impressions).doc();
        const impDoc: ImpressionDoc = {
          userId, characterId,
          content: op.content.trim().slice(0, 200),
          kind,
          supportingEpisodes: [ep.id],
          status: 'active',
          supersededBy: null,
          lastReinforcedAt: now,
          createdAt: now,
        };
        newImpressionsByVirtualIdx.set(virtualIdx, { ref, doc: impDoc });
        if (!dryRun) {
          const emb = await generateEmbedding(impDoc.content).catch(() => null);
          await ref.set(emb ? { ...impDoc, embedding: emb } : impDoc);
          await epRef.update({ consolidatedAt: now, consolidatedInto: ref.id });
        }

      } else if (op.op === 'contradict' && typeof op.impression === 'number' && typeof op.updated === 'string' && op.updated.trim()) {
        // 只允許推翻「既有」印象（本批虛擬印象內互相矛盾 = LLM 自己亂，當 skip）
        if (op.impression < 1 || op.impression > impressions.length) {
          base.skipped++;
          detail.push({ ep: ep.content.slice(0, 40), op: 'skip(矛盾引用越界)' });
          continue;
        }
        const old = impressions[op.impression - 1];
        base.superseded++;
        detail.push({ ep: ep.content.slice(0, 40), op: `contradict#${op.impression}`, old: old.content.slice(0, 40), updated: op.updated.trim().slice(0, 60) });
        if (!dryRun) {
          const newRef = db.collection(COL.impressions).doc();
          const emb = await generateEmbedding(op.updated.trim()).catch(() => null);
          const newDoc: ImpressionDoc = {
            userId, characterId,
            content: op.updated.trim().slice(0, 200),
            kind: old.kind,
            supportingEpisodes: [ep.id],
            status: 'active',
            supersededBy: null,
            lastReinforcedAt: now,
            createdAt: now,
          };
          await newRef.set(emb ? { ...newDoc, embedding: emb } : newDoc);
          await db.collection(COL.impressions).doc(old.id).update({
            status: 'superseded',
            supersededBy: newRef.id,
          });
          await epRef.update({ consolidatedAt: now, consolidatedInto: newRef.id });
        }

      } else {
        base.skipped++;
        detail.push({ ep: ep.content.slice(0, 40), op: 'skip' });
        if (!dryRun) {
          await epRef.update({ consolidatedAt: now }); // 處理過但沒被吸收——照常走情節生命週期
        }
      }
    }

    // LLM 漏答的情節：不標 consolidatedAt、watermark 不越過它們？——為簡單起見，
    // 漏答視同 skip（標 consolidatedAt），watermark 照推。漏答率高會反映在 detail 裡可查。
    for (let i = 1; i <= episodes.length; i++) {
      if (!seenEpisodes.has(i)) {
        base.skipped++;
        detail.push({ ep: episodes[i - 1].content.slice(0, 40), op: 'skip(LLM漏答)' });
        if (!dryRun) {
          await db.collection(COL.memories).doc(episodes[i - 1].id).update({ consolidatedAt: now });
        }
      }
    }

    // 4. watermark 推進
    if (!dryRun && newWatermark > watermark && relSnap.exists) {
      await relRef.update({ consolidationWatermark: Timestamp.fromMillis(newWatermark) });
    }

    base.detail = detail;
    return base;
  } catch (e) {
    console.error(`[consolidation] pair failed: ${userId}×${characterId}:`, e instanceof Error ? e.message : String(e));
    return { ...base, status: 'error' };
  }
}

/**
 * 全量跑：掃 relationships 當配對名冊，逐對鞏固。
 * timeBudgetMs 到了就停，剩的下輪（watermark 保證不重不漏）。
 */
export async function runConsolidation(
  db: Firestore,
  client: LLMClient,
  opts: { dryRun?: boolean; timeBudgetMs?: number; onlyPair?: { userId: string; characterId: string } } = {},
): Promise<{ pairs: PairResult[]; timeBudgetHit: boolean }> {
  const timeBudgetMs = opts.timeBudgetMs ?? 240_000;
  const startedAt = Date.now();
  const results: PairResult[] = [];
  let timeBudgetHit = false;

  const relSnap = await db.collection(COL.relationships).limit(500).get();
  const charNames = new Map<string, string>();

  for (const relDoc of relSnap.docs) {
    const rel = relDoc.data() as RelationshipDoc;
    if (opts.onlyPair && (rel.userId !== opts.onlyPair.userId || rel.characterId !== opts.onlyPair.characterId)) continue;
    if (Date.now() - startedAt > timeBudgetMs) { timeBudgetHit = true; break; }

    if (!charNames.has(rel.characterId)) {
      const c = await db.collection(COL.characters).doc(rel.characterId).get();
      charNames.set(rel.characterId, c.exists ? String(c.data()!.name || '角色') : '角色');
    }
    const r = await consolidatePair(db, rel.userId, rel.characterId, charNames.get(rel.characterId)!, client, { dryRun: opts.dryRun });
    if (r.status !== 'empty') results.push(r);
  }
  return { pairs: results, timeBudgetHit };
}
