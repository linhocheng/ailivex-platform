/**
 * /api/admin/memory-health — 記憶健康巡檢的後台介面（middleware 已限 admin）
 *   GET  最近 N 輪巡檢結果（含觸發時間/觸發來源/狀態/發現/觀察者評語）
 *   POST 立即巡檢（trigger=manual），同步回傳本輪結果
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type MemoryHealthRunDoc } from '@/lib/collections';
import { runMemoryHealthCheck } from '@/lib/memory-health';

export const runtime = 'nodejs';
export const maxDuration = 180;

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const t = v as { toDate?: () => Date };
  return typeof t.toDate === 'function' ? t.toDate().toISOString() : null;
}

function serialize(id: string, run: MemoryHealthRunDoc) {
  return { id, ...run, triggeredAt: toIso(run.triggeredAt) };
}

export async function GET(req: Request) {
  const limit = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get('limit') || 10)));
  const db = getFirestore();
  const snap = await db.collection(COL.memoryHealthRuns)
    .orderBy('triggeredAt', 'desc')
    .limit(limit)
    .get();
  return NextResponse.json({
    runs: snap.docs.map(d => serialize(d.id, d.data() as MemoryHealthRunDoc)),
  });
}

export async function POST() {
  const db = getFirestore();
  const result = await runMemoryHealthCheck(db, 'manual');
  const { id, ...run } = result;
  return NextResponse.json({ run: serialize(id, run) });
}
