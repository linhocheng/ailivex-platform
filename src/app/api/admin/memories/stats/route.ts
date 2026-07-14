import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';

export const runtime = 'nodejs';

// GET /api/admin/memories/stats — 各角色記憶數統計（總數 / tier / status 缺失數）
// select() 只拉三欄，498 條等級的全掃很輕；量級上萬再改 count() 聚合查詢。
export async function GET() {
  const db = getFirestore();
  const snap = await db.collection(COL.memories)
    .select('characterId', 'tier', 'status')
    .get();

  const byChar: Record<string, { total: number; core: number; fresh: number; archive: number; noStatus: number }> = {};
  for (const d of snap.docs) {
    const m = d.data() as { characterId?: string; tier?: string; status?: string };
    const cid = m.characterId || '(unknown)';
    byChar[cid] ??= { total: 0, core: 0, fresh: 0, archive: 0, noStatus: 0 };
    const s = byChar[cid];
    s.total++;
    if (m.tier === 'core') s.core++;
    else if (m.tier === 'archive') s.archive++;
    else s.fresh++;
    if (!m.status) s.noStatus++;
  }
  return NextResponse.json({ total: snap.size, byChar });
}
