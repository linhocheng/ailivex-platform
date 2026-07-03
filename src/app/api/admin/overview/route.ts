/**
 * /api/admin/overview — 後台健康度摘要（Stripe 式「一切正常嗎」首屏）
 *
 * 一次回傳：用戶數、角色數、指派數、文件總數、語音已用總時數、額度用罄告警。
 * count() 聚合查詢不拉整包文件，量大也快。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type UserDoc } from '@/lib/collections';

export const runtime = 'nodejs';

export async function GET() {
  const db = getFirestore();

  const [usersSnap, charsCount, accessCount, docsCount] = await Promise.all([
    db.collection(COL.users).get(),
    db.collection(COL.characters).where('status', '==', 'active').count().get(),
    db.collection(COL.access).count().get(),
    db.collection(COL.documents).count().get(),
  ]);

  let voiceSecondsTotal = 0;
  let voiceExhausted = 0;
  let docsExhausted = 0;
  let userCount = 0;
  for (const d of usersSnap.docs) {
    const u = d.data() as UserDoc;
    if (u.role !== 'user') continue;
    userCount++;
    voiceSecondsTotal += Number(u.voiceSecondsUsed || 0);
    if (typeof u.voiceSecondsLimit === 'number' && Number(u.voiceSecondsUsed || 0) >= u.voiceSecondsLimit) voiceExhausted++;
    if (typeof u.docsLimit === 'number' && Number(u.docsUsed || 0) >= u.docsLimit) docsExhausted++;
  }

  return NextResponse.json({
    users: userCount,
    characters: charsCount.data().count,
    access: accessCount.data().count,
    documents: docsCount.data().count,
    voiceMinutesTotal: Math.round(voiceSecondsTotal / 60),
    quotaAlerts: voiceExhausted + docsExhausted,
  });
}
