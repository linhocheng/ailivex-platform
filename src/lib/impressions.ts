/**
 * 印象層讀取 —— 記憶全景圖第二期（2026-07-07）。
 *
 * 印象 = 信念（「我對他的理解」），由夜間鞏固管線（consolidation.ts）從情節消化而來。
 * 這裡只管讀：載入 active 印象、確定性算 confidence、組 prompt 塊。
 *
 * confidence 是純數學不落庫：支持情節越多越確定，太久沒被強化會淡。
 * 說話方式跟著 confidence 走——模糊的印象用「好像」的口吻，這就是「更像人」。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL, type ImpressionDoc, type ImpressionKind } from '@/lib/collections';
import { cosineSimilarity } from '@/lib/embeddings';

export type ImpressionWithId = ImpressionDoc & { id: string };

const MAX_FACT_IMPRESSIONS = 6;      // 印象比原始情節精煉，配額比 MAX_FACTS(4) 稍寬
const MAX_PREF_IMPRESSIONS = 4;

/**
 * Canary 閘：IMPRESSION_CANARY_USERS 未設 = 全關；'*' = 全開；否則逗號分隔 userId 白名單。
 */
export function impressionsEnabled(userId: string): boolean {
  const canary = (process.env.IMPRESSION_CANARY_USERS || '').trim();
  if (!canary) return false;
  if (canary === '*') return true;
  return canary.split(',').map(s => s.trim()).includes(userId);
}

/**
 * 信心度（0.2 ~ 0.95，確定性計算）：
 *   基礎 = 支持情節數（1條→0.40，2→0.54，3→0.68，4→0.82，5+→0.95 封頂）
 *   衰減 = 每 30 天沒被強化 -0.06
 */
export function confidenceOf(imp: Pick<ImpressionDoc, 'supportingEpisodes' | 'lastReinforcedAt' | 'explicitSupport'>, now = Date.now()): number {
  const n = Math.max(1, imp.supportingEpisodes?.length ?? 1);
  // 顯式來源（用戶/角色主動要求記住）比自動提煉可信：有 explicitSupport 加 0.1（封頂前）
  const explicitBonus = (imp.explicitSupport ?? 0) > 0 ? 0.1 : 0;
  const base = Math.min(0.95, 0.4 + 0.14 * (n - 1) + explicitBonus);
  const ts = imp.lastReinforcedAt instanceof Date
    ? imp.lastReinforcedAt.getTime()
    : (imp.lastReinforcedAt as { toDate(): Date })?.toDate?.().getTime() ?? now;
  const monthsStale = Math.max(0, (now - ts) / (30 * 86400_000));
  return Math.max(0.2, Math.round((base - 0.06 * monthsStale) * 100) / 100);
}

/** confidence → 說話口吻標記（prompt 塊用） */
export function confidenceMarker(c: number): string {
  if (c >= 0.65) return '◆';
  if (c >= 0.45) return '◇';
  return '～';
}

export async function loadActiveImpressions(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<ImpressionWithId[]> {
  const snap = await db.collection(COL.impressions)
    .where('userId', '==', userId)
    .where('characterId', '==', characterId)
    .limit(100)
    .get();
  return snap.docs
    .map(d => ({ ...(d.data() as ImpressionDoc), id: d.id }))
    .filter(i => i.status === 'active');
}

/**
 * 組印象區塊（取代舊的 fact/preference 原始情節區塊）。
 * qEmb 有值時按「相關性 × 信心度」排序，否則按信心度。
 * 回傳兩段：了解（fact）與習慣（preference），任一可為空字串。
 */
export function buildImpressionSections(
  impressions: ImpressionWithId[],
  qEmb: number[] | null,
  fresh?: { factLines?: string[]; prefLines?: string[] }, // 尚未消化成印象的新鮮情節（・標記）
): { factSection: string; prefSection: string; usedIds: string[] } {
  const now = Date.now();
  const pick = (kind: ImpressionKind, cap: number) => {
    return impressions
      .filter(i => i.kind === kind)
      .map(i => {
        const conf = confidenceOf(i, now);
        const rel = qEmb && Array.isArray(i.embedding) && i.embedding.length > 0
          ? cosineSimilarity(qEmb, i.embedding) : 0.5;
        return { i, conf, score: conf * 0.6 + rel * 0.4 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, cap);
  };

  const fmt = (x: { i: ImpressionWithId; conf: number }) =>
    `${confidenceMarker(x.conf)} ${x.i.content}`;

  const facts = pick('fact', MAX_FACT_IMPRESSIONS);
  const prefs = pick('preference', MAX_PREF_IMPRESSIONS);
  const freshFacts = (fresh?.factLines ?? []).map(l => `・ ${l}`);
  const freshPrefs = (fresh?.prefLines ?? []).map(l => `・ ${l}`);
  const legend = '\n（◆=很確定 ◇=大致確定 ～=模糊印象 ・=最近剛聊到。模糊的用「你好像說過⋯」「我記得不太清」的口吻，別說得斬釘截鐵；很確定的自然當常識用。）';

  const factLines = [...facts.map(fmt), ...freshFacts];
  const prefLines = [...prefs.map(fmt), ...freshPrefs];

  return {
    factSection: factLines.length > 0
      ? `\n\n【我對這個人的理解】\n${factLines.join('\n')}${legend}`
      : '',
    prefSection: prefLines.length > 0
      ? `\n\n【我記得他的習慣】\n${prefLines.join('\n')}`
      : '',
    usedIds: [...facts, ...prefs].map(x => x.i.id),
  };
}
