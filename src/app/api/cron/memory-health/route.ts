/**
 * GET /api/cron/memory-health — 記憶健康巡檢（Vercel Cron 每日 20:00 UTC = 台北 04:00，
 * 排在鞏固 18:00 與維護 19:00 之後——先讓管線跑完，再驗收它們跑得對不對）。
 *
 * 巡檢本體在 src/lib/memory-health.ts（確定性檢查 + 觀察者評語），
 * 結果落 memory_health_runs，後台 /admin/memories 頂部面板可看、可手動觸發。
 *
 * 鑑權：Vercel Cron 帶 Authorization: Bearer ${CRON_SECRET}；本機/手動可帶同值測試。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { verifyBearerSecret } from '@/lib/clean-env';
import { wrapCron } from '@/lib/ops-event';
import { runMemoryHealthCheck } from '@/lib/memory-health';

export const runtime = 'nodejs';
// embedding 抽測（8 次 Vertex）＋觀察者一次 bridge call（冷 34s）
export const maxDuration = 180;

export const GET = wrapCron('memory-health', run);

async function run(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const db = getFirestore();
  const result = await runMemoryHealthCheck(db, 'cron');
  console.log(`[memory-health] status=${result.status} findings=${result.findings.length} durationMs=${result.durationMs}`);
  return NextResponse.json({
    id: result.id, status: result.status,
    findings: result.findings.length, durationMs: result.durationMs,
  });
}
