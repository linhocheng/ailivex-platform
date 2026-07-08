/**
 * 單一方法論 —— PATCH 編輯（triggerDesc 變更時重嵌）/ DELETE 刪除（計數同步遞減）。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type MethodologyDoc } from '@/lib/collections';
import { generateKnowledgeEmbedding } from '@/lib/embeddings';
import { sanitizeSteps, MAX_STEPS } from '@/lib/methodology';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string; mid: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id, mid } = await params;
  const body = await req.json().catch(() => null) as {
    name?: string; purpose?: string; triggerDesc?: string;
    preconditions?: string[]; steps?: unknown;
  } | null;

  const db = getFirestore();
  const ref = db.collection(COL.methodologies).doc(mid);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '方法論不存在' }, { status: 404 });
  const existing = snap.data() as MethodologyDoc;
  if (existing.characterId !== id) return NextResponse.json({ error: '方法論不屬於此角色' }, { status: 400 });

  const updates: Partial<MethodologyDoc> = {};
  if (body?.name?.trim()) updates.name = body.name.trim();
  if (body?.purpose?.trim()) updates.purpose = body.purpose.trim();
  if (Array.isArray(body?.preconditions)) {
    updates.preconditions = body.preconditions
      .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  }
  if (body?.steps !== undefined) {
    const steps = sanitizeSteps(body.steps);
    if (!steps) return NextResponse.json({ error: `steps 需為 1-${MAX_STEPS} 步、每步含 instruction` }, { status: 400 });
    updates.steps = steps;
  }
  // 觸發描述變了 → 重嵌（選招靠它）
  if (body?.triggerDesc?.trim() && body.triggerDesc.trim() !== existing.triggerDesc) {
    updates.triggerDesc = body.triggerDesc.trim();
    const emb = await generateKnowledgeEmbedding(updates.triggerDesc, 'document').catch(() => null);
    if (emb) updates.triggerEmb = emb;
  }

  await ref.update(updates as Record<string, unknown>);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, mid } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.methodologies).doc(mid);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '方法論不存在' }, { status: 404 });
  if ((snap.data() as MethodologyDoc).characterId !== id) {
    return NextResponse.json({ error: '方法論不屬於此角色' }, { status: 400 });
  }

  await ref.delete();
  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection(COL.characters).doc(id)
    .update({ methodologyCount: FieldValue.increment(-1) })
    .catch(() => {});

  return NextResponse.json({ ok: true });
}
