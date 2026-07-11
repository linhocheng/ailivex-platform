/**
 * GET /api/cron/ops-rollup — 每小時聚合快照（Vercel Cron，每小時 :05 呼叫）
 *
 * 寫上一個整點小時的 ops_rollups doc（冪等，重跑覆寫同一筆）。
 * 監控中台的趨勢 sparkline 與寬時間窗加總都靠這條——它自己也掛 cron 心跳燈。
 *
 * 鑑權：Authorization: Bearer ${CRON_SECRET}（同其他 cron）。
 */
import { NextResponse } from 'next/server';
import { verifyBearerSecret } from '@/lib/clean-env';
import { wrapCron } from '@/lib/ops-event';
import { computeHourlyRollup } from '@/lib/ops-rollup';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = wrapCron('ops-rollup', run);

async function run(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await computeHourlyRollup();
  return NextResponse.json({ ok: true, ...result });
}
