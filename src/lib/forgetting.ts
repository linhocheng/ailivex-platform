/**
 * 遺忘曲線＋老情節模糊化 —— 記憶全景圖第三期（2026-07-08）。
 *
 * 像人一樣忘：情緒重的記憶衰減慢（遺忘曲線），老情節細節淡成大意（模糊化），
 * 但原文永不硬刪——出處鏈（impression.supportingEpisodes 引用的 doc id）保持有效。
 *
 * 分工守天條：emotionalWeight 與門檻縮放全是確定性計算（老資料立即受益，不需回填欄位）；
 * LLM 只做「寫大意」這一件生成的事，驗證、覆寫、embedding 重算全程式。
 * LLM 輸出壞 → 本輪整批跳過，下輪重試——不 re-ask 模型修（天條）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL, type MemoryDoc } from '@/lib/collections';
import { generateEmbedding } from '@/lib/embeddings';
import { parseJsonLoose } from '@/lib/safe-json';
import { trackCost } from '@/lib/cost-tracker';

// ─── 遺忘曲線 ─────────────────────────────────────────────────────────────────

/**
 * 情緒權重（0~1，確定性推導，不落庫）：type 給底、importance 加成。
 * emotion/milestone 天生重（人不會忘掉大哭大笑的日子），promise 次之，fact 全靠 importance。
 */
export function emotionalWeightOf(m: Pick<MemoryDoc, 'type' | 'importance' | 'emotionTag'>): number {
  const typeBoost =
    m.type === 'emotion' || m.type === 'milestone' ? 0.4
    : m.type === 'promise' ? 0.3
    : m.type === 'preference' ? 0.15
    : 0;
  return Math.min(1, typeBoost + ((m.importance ?? 5) / 10) * 0.6);
}

/** 門檻縮放：權重 1.0 的記憶活兩倍長（30d→60d、90d→180d）。 */
export function effectiveDays(baseDays: number, weight: number): number {
  return baseDays * (1 + weight);
}

// ─── 老情節模糊化（gist 化）─────────────────────────────────────────────────────

const GIST_MODEL = 'claude-haiku-4-5-20251001'; // 寫大意不需要 Sonnet
const GIST_AFTER_DAYS = 30;    // 多老才模糊化
const GIST_MIN_CHARS = 80;     // 短句沒有細節可淡，不值一次覆寫
const GIST_BATCH_LIMIT = 12;   // 每晚一批的上限（一次 LLM call）

/** Canary 閘：GIST_CANARY_USERS 未設 = 全關；'*' = 全開；否則逗號分隔 userId 白名單。 */
export function gistEnabled(userId: string): boolean {
  const canary = (process.env.GIST_CANARY_USERS || '').trim();
  if (!canary) return false;
  if (canary === '*') return true;
  return canary.split(',').map(s => s.trim()).includes(userId);
}

type LLMClient = {
  messages: {
    create: (args: {
      model: string; max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>;
  };
};

export interface GistResult {
  candidates: number;
  gisted: number;
  skipped: number;   // LLM 給的大意沒過驗證（沒變短/空白/越界）
  status: 'done' | 'empty' | 'llm_error' | 'error';
  detail?: Array<{ id: string; before: number; after: number }>;
}

function toMillis(t: unknown): number {
  if (!t) return 0;
  if (t instanceof Date) return t.getTime();
  const d = (t as { toDate?: () => Date }).toDate?.();
  return d ? d.getTime() : 0;
}

/**
 * 跑一輪模糊化：archive 層、夠老、夠長、還沒 gist 過、canary 內的情節，
 * 一次 LLM call 寫大意 → 程式驗證 → content 蓋成大意、原文存 rawContent、embedding 重算。
 * doc id 不變，impression 的出處鏈照常可溯。
 */
export async function runGistPass(
  db: Firestore,
  client: LLMClient,
  opts: { dryRun?: boolean } = {},
): Promise<GistResult> {
  const dryRun = opts.dryRun ?? false;
  const base: GistResult = { candidates: 0, gisted: 0, skipped: 0, status: 'done' };
  try {
    const ageCutoff = Date.now() - GIST_AFTER_DAYS * 86400_000;
    const snap = await db.collection(COL.memories)
      .where('tier', '==', 'archive')
      .limit(500)
      .get();

    const candidates = snap.docs
      .map(d => ({ ref: d.ref, id: d.id, m: d.data() as MemoryDoc & { rawContent?: string } }))
      .filter(({ m }) =>
        gistEnabled(m.userId)
        && !m.rawContent
        && (m.content?.length ?? 0) >= GIST_MIN_CHARS
        && toMillis(m.createdAt) > 0 && toMillis(m.createdAt) < ageCutoff)
      .slice(0, GIST_BATCH_LIMIT);

    base.candidates = candidates.length;
    if (candidates.length === 0) return { ...base, status: 'empty' };

    const numbered = candidates.map((c, i) => `${i}. ${c.m.content}`).join('\n');
    const res = await client.messages.create({
      model: GIST_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `以下是一些很久以前的記憶，請為每一條寫「大意」——像人回想一個月前的事：留下發生了什麼（保留人名、地名、具體事實），細節與逐字對話淡掉。每條大意必須明顯比原文短。

${numbered}

只回 <result>JSON</result>，格式：<result>[{"i":0,"gist":"..."}]</result>`,
      }],
    });
    await trackCost('system', GIST_MODEL, res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0, 'gist', 'maintenance');

    const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    const match = text.match(/<result>([\s\S]*?)<\/result>/);
    const items = match ? parseJsonLoose<Array<{ i: number; gist: string }>>(match[1].trim()) : null;
    if (!Array.isArray(items)) {
      console.warn('[gist] LLM 輸出無法解析，本輪跳過（下輪重試）');
      return { ...base, status: 'llm_error' };
    }

    const detail: GistResult['detail'] = [];
    for (const item of items) {
      const c = candidates[item.i];
      const gist = (item.gist ?? '').trim();
      // 驗證：對得上號、非空、真的變短（至少省 20%）
      if (!c || !gist || gist.length < 8 || gist.length > c.m.content.length * 0.8) {
        base.skipped++;
        continue;
      }
      if (!dryRun) {
        const embedding = await generateEmbedding(gist).catch(() => null);
        await c.ref.update({
          content: gist,
          rawContent: c.m.content,          // 原文不硬刪
          gistedAt: new Date(),
          ...(embedding ? { embedding } : {}),
        });
      }
      base.gisted++;
      detail.push({ id: c.id, before: c.m.content.length, after: gist.length });
    }
    return { ...base, detail: dryRun ? detail : undefined };
  } catch (e) {
    console.error('[gist] runGistPass failed:', e instanceof Error ? e.message : String(e));
    return { ...base, status: 'error' };
  }
}
