/**
 * GET /api/cron/memory-maintenance — 記憶新陳代謝（Vercel Cron 每日呼叫）
 *
 * 之前 tier 晉升/歸檔只有 admin 後台手動按鈕（實質半癱）。這裡自動化：
 *   fresh → core    : hitCount >= 3
 *   fresh → archive : 逾 30 天且 hitCount == 0
 *   core  → archive : 逾 90 天未命中
 * 加上 stale 掃描（question 60d / emotion 90d → status=stale），
 * 不再依賴讀取時的懶惰觸發。
 *
 * 鑑權：Vercel Cron 帶 Authorization: Bearer ${CRON_SECRET}；本機/手動可帶同值測試。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyBearerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FRESH_TO_CORE_HITS = 3;
const FRESH_STALE_DAYS = 30;
const CORE_STALE_DAYS = 90;
const QUESTION_STALE_DAYS = 60;
const EMOTION_STALE_DAYS = 90;

export async function GET(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = getFirestore();
  const now = Date.now();
  const freshCutoff = now - FRESH_STALE_DAYS * 86400_000;
  const coreCutoff = now - CORE_STALE_DAYS * 86400_000;
  const questionCutoff = now - QUESTION_STALE_DAYS * 86400_000;
  const emotionCutoff = now - EMOTION_STALE_DAYS * 86400_000;

  const snap = await db.collection(COL.memories)
    .where('tier', 'in', ['fresh', 'core'])
    .limit(1000)
    .get();

  let promoted = 0, archived = 0, staled = 0;
  const batch = db.batch();

  for (const doc of snap.docs) {
    const m = doc.data();
    const createdMs = (m.createdAt as Timestamp)?.toMillis?.() ?? 0;
    const lastHitMs = m.lastHitAt ? ((m.lastHitAt as Timestamp)?.toMillis?.() ?? 0) : 0;
    const status = m.status ?? 'active';

    // stale：懸而未決太久 / 情緒過期
    if (status === 'active') {
      if (m.type === 'question' && createdMs && createdMs < questionCutoff) {
        batch.update(doc.ref, { status: 'stale' }); staled++; continue;
      }
      if (m.type === 'emotion' && createdMs && createdMs < emotionCutoff) {
        batch.update(doc.ref, { status: 'stale' }); staled++; continue;
      }
    }

    // tier 新陳代謝
    if (m.tier === 'fresh') {
      if ((m.hitCount ?? 0) >= FRESH_TO_CORE_HITS) {
        batch.update(doc.ref, { tier: 'core' }); promoted++;
      } else if (createdMs && createdMs < freshCutoff && (m.hitCount ?? 0) === 0) {
        batch.update(doc.ref, { tier: 'archive' }); archived++;
      }
    } else if (m.tier === 'core') {
      const ref = lastHitMs || createdMs;
      if (ref && ref < coreCutoff) {
        batch.update(doc.ref, { tier: 'archive' }); archived++;
      }
    }
  }

  await batch.commit();
  console.log(`[memory-maintenance] promoted=${promoted} archived=${archived} staled=${staled} scanned=${snap.size}`);
  return NextResponse.json({ scanned: snap.size, promoted, archived, staled });
}
