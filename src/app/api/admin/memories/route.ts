import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type MemoryDoc } from '@/lib/collections';

export const runtime = 'nodejs';

// GET /api/admin/memories?userId=&characterId=&tier=&limit=
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId') || '';
  const characterId = searchParams.get('characterId') || '';
  const tier = searchParams.get('tier') || '';
  const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);

  const db = getFirestore();
  // orderBy + where 組合需要 composite index，改為 equality filters only，JS 端排序
  let q = db.collection(COL.memories) as FirebaseFirestore.Query;
  if (userId) q = q.where('userId', '==', userId);
  if (characterId) q = q.where('characterId', '==', characterId);
  if (tier) q = q.where('tier', '==', tier);
  if (!userId && !characterId && !tier) q = q.orderBy('createdAt', 'desc');
  q = q.limit(limit);

  const snap = await q.get();
  const memories = snap.docs.map(d => {
    const m = d.data() as MemoryDoc;
    return {
      id: d.id,
      userId: m.userId,
      characterId: m.characterId,
      content: m.content,
      tier: m.tier,
      type: m.type ?? null,
      status: m.status ?? null,
      importance: m.importance,
      hitCount: m.hitCount,
      source: m.source,
      lastHitAt: m.lastHitAt ? (m.lastHitAt as FirebaseFirestore.Timestamp).toMillis?.() ?? null : null,
      createdAt: (m.createdAt as FirebaseFirestore.Timestamp).toMillis?.() ?? null,
    };
  });
  memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return NextResponse.json({ memories, total: memories.length });
}
