/**
 * Tier promotion 批次規則：
 *   fresh  → core    : hitCount >= 3
 *   fresh  → archive : createdAt 超過 30 天 且 hitCount == 0
 *   core   → archive : lastHitAt 超過 90 天
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';

const FRESH_TO_CORE_HITS = 3;
const FRESH_STALE_DAYS = 30;
const CORE_STALE_DAYS = 90;

export async function POST() {
  const db = getFirestore();
  const now = Date.now();
  const freshStaleCutoff = now - FRESH_STALE_DAYS * 86400_000;
  const coreStaleCutoff = now - CORE_STALE_DAYS * 86400_000;

  const snap = await db.collection(COL.memories)
    .where('tier', 'in', ['fresh', 'core'])
    .limit(1000)
    .get();

  const promoted: string[] = [];
  const archived: string[] = [];
  const batch = db.batch();

  for (const doc of snap.docs) {
    const m = doc.data();
    const createdMs = (m.createdAt as Timestamp).toMillis?.() ?? 0;
    const lastHitMs = m.lastHitAt ? ((m.lastHitAt as Timestamp).toMillis?.() ?? 0) : 0;

    if (m.tier === 'fresh') {
      if ((m.hitCount ?? 0) >= FRESH_TO_CORE_HITS) {
        batch.update(doc.ref, { tier: 'core' });
        promoted.push(doc.id);
      } else if (createdMs < freshStaleCutoff && (m.hitCount ?? 0) === 0) {
        batch.update(doc.ref, { tier: 'archive' });
        archived.push(doc.id);
      }
    } else if (m.tier === 'core') {
      const cutoff = lastHitMs || createdMs;
      if (cutoff < coreStaleCutoff) {
        batch.update(doc.ref, { tier: 'archive' });
        archived.push(doc.id);
      }
    }
  }

  await batch.commit();
  return NextResponse.json({ promoted: promoted.length, archived: archived.length });
}

// suppress unused import warning
void FieldValue;
