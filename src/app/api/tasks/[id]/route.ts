/**
 * PATCH /api/tasks/[id]
 * 更新 task 的可編修欄位（storyText、cardText、cardType、intent）。
 * 限用戶本人操作。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({})) as {
    storyText?: string;
    cardText?: string;
    cardType?: string;
    intent?: string;
  };

  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const patch: Record<string, unknown> = {};
  if (body.storyText !== undefined) patch.storyText = body.storyText;
  if (body.cardText !== undefined) patch.cardText = body.cardText;
  if (body.cardType !== undefined) patch.cardType = body.cardType;
  if (body.intent !== undefined) patch.intent = body.intent;

  if (!Object.keys(patch).length) return NextResponse.json({ ok: true });
  await ref.update(patch);
  return NextResponse.json({ ok: true });
}
