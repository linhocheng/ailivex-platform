/**
 * GET  /api/stories/[id]   故事詳情（story_draft + 所有圖卡子任務）
 * PATCH /api/stories/[id]  更新 storyText（用戶編修後儲存）
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

function toMillis(v: TaskDoc['createdAt'] | undefined): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  return (v as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
}

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();

  const [storySnap, cardsSnap] = await Promise.all([
    db.collection(COL.tasks).doc(id).get(),
    db.collection(COL.tasks).where('parentTaskId', '==', id).get(),
  ]);

  if (!storySnap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const t = storySnap.data() as TaskDoc & Record<string, unknown>;
  if (t.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const cards = cardsSnap.docs.map(d => {
    const c = d.data() as TaskDoc & Record<string, unknown>;
    return {
      id: d.id,
      order: (c.order as number) ?? 0,
      intent: c.intent || '',
      cardText: (c.cardText as string) || '',
      cardType: (c.cardType as string) || 'realistic_photo',
      status: c.status as string,
      imageUrl: (c.imageUrl as string) || '',
      productImageUrl: (c.productImageUrl as string) || '',
      error: (c.error as string) || '',
      createdAt: toMillis(c.createdAt),
    };
  }).sort((a, b) => a.order - b.order);

  return NextResponse.json({
    id,
    intent: t.intent || '',
    characterId: t.characterId,
    status: t.status as string,
    storyText: (t.storyText as string) || '',
    brandLayoutId: (t.brandLayoutId as string) || '',
    error: (t.error as string) || '',
    createdAt: toMillis(t.createdAt),
    cards,
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { storyText?: string; brandLayoutId?: string };

  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const patch: Record<string, unknown> = {};
  if (body.storyText !== undefined) patch.storyText = body.storyText;
  if (body.brandLayoutId !== undefined) patch.brandLayoutId = body.brandLayoutId;
  if (Object.keys(patch).length) await ref.update(patch);
  return NextResponse.json({ ok: true });
}
