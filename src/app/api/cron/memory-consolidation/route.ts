/**
 * GET /api/cron/memory-consolidation — 夜間鞏固管線（Vercel Cron 每日 18:00 UTC = 台北 02:00）
 *
 * 排在 memory-maintenance（19:00 UTC）之前：先消化再衰減，
 * 未消化的情節不會先被 tier 代謝掃進 archive。
 *
 * 引擎在 @/lib/consolidation（情節→印象、支持/新增/矛盾推翻、watermark）。
 * ?dryRun=1 只回計畫不寫；?userId=&characterId= 只跑單一配對（驗證用）。
 *
 * 鑑權：Bearer CRON_SECRET（與 memory-maintenance 同）。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { runConsolidation } from '@/lib/consolidation';
import { verifyBearerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
// 300：多配對 × 每對一次 bridge call（實測冷 34s/暖 7.5s），60s 裝不下
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const userId = url.searchParams.get('userId') || '';
  const characterId = url.searchParams.get('characterId') || '';

  const db = getFirestore();
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 60_000 });

  const { pairs, timeBudgetHit } = await runConsolidation(db, client, {
    dryRun,
    timeBudgetMs: 240_000, // 留 60s 給收尾
    onlyPair: userId && characterId ? { userId, characterId } : undefined,
  });

  const summary = {
    dryRun,
    pairsProcessed: pairs.length,
    timeBudgetHit,
    totals: pairs.reduce((a, p) => ({
      episodes: a.episodes + p.episodes,
      supported: a.supported + p.supported,
      created: a.created + p.created,
      superseded: a.superseded + p.superseded,
      skipped: a.skipped + p.skipped,
    }), { episodes: 0, supported: 0, created: 0, superseded: 0, skipped: 0 }),
    pairs: pairs.map(p => ({ ...p, detail: dryRun ? p.detail : undefined })),
  };
  console.log(`[consolidation] ${JSON.stringify({ ...summary, pairs: undefined })}`);
  return NextResponse.json(summary);
}
