/**
 * GET /api/cron/voice-auto-off — 語音引擎自動關機（Vercel Cron 每 30 分呼叫）
 *
 * 開著才有錢在燒；「忘記關」是唯一漏財路徑。這裡兜底：
 * 開啟中且距離「最近開啟」與「最近撥號」都超過 autoOffHours（預設 3 小時）→ 自動切關。
 *
 * 鑑權：Vercel Cron 帶 Authorization: Bearer ${CRON_SECRET}（同 memory-maintenance）。
 */
import { NextResponse } from 'next/server';
import { verifyBearerSecret } from '@/lib/clean-env';
import { readVoicePowerFlag, setVoicePower, AUTO_OFF_HOURS_DEFAULT } from '@/lib/voice-power';
import { wrapCron } from '@/lib/ops-event';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = wrapCron('voice-auto-off', run);

async function run(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const flag = await readVoicePowerFlag();
  if (!flag.on) return NextResponse.json({ ok: true, action: 'none', reason: '已是關閉狀態' });

  const hours = flag.autoOffHours ?? AUTO_OFF_HOURS_DEFAULT;
  const idleSinceMs = Math.max(
    flag.onSince ? Date.parse(flag.onSince) : 0,
    flag.lastCallAt ? Date.parse(flag.lastCallAt) : 0,
  );
  // 沒有任何時間戳（舊 doc）：不敢判定閒置多久，先戳 onSince 讓下一輪起算
  if (!idleSinceMs) {
    await setVoicePower(true, 'auto-off');
    return NextResponse.json({ ok: true, action: 'stamp', reason: '無時間戳，重新起算' });
  }

  const idleHours = (Date.now() - idleSinceMs) / 3600_000;
  if (idleHours < hours) {
    return NextResponse.json({ ok: true, action: 'none', idleHours: +idleHours.toFixed(2), threshold: hours });
  }

  await setVoicePower(false, 'auto-off');
  return NextResponse.json({ ok: true, action: 'off', idleHours: +idleHours.toFixed(2), threshold: hours });
}
