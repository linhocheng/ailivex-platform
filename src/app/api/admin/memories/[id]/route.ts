import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

// PATCH — 改 tier / status / importance
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as { tier?: string; status?: string; importance?: number } | null;
  if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body?.tier && ['fresh', 'core', 'archive'].includes(body.tier)) updates.tier = body.tier;
  if (body?.status && ['active', 'stale', 'resolved'].includes(body.status)) updates.status = body.status;
  if (typeof body?.importance === 'number') updates.importance = Math.max(1, Math.min(10, body.importance));
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: '無可更新欄位' }, { status: 400 });

  await getFirestore().collection(COL.memories).doc(id).update(updates);
  return NextResponse.json({ ok: true });
}

// DELETE — 刪單筆
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });
  await getFirestore().collection(COL.memories).doc(id).delete();
  return NextResponse.json({ ok: true });
}
