/**
 * PATCH /api/tasks/[id]
 * 更新 task 的可編修欄位（storyText、cardText、cardType、intent）。
 * 限用戶本人操作。
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.tasks).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const task = snap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  return NextResponse.json({
    status: task.status,
    podcastScript: task.podcastScript ?? null,
    audioUrl: (task as TaskDoc & { audioUrl?: string }).audioUrl ?? null,
    podcastPhase: (task as TaskDoc & { podcastPhase?: string }).podcastPhase ?? null,
    error: task.error ?? null,
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({})) as {
    storyText?: string;
    cardText?: string;
    cardType?: string;
    intent?: string;
    productImageUrl?: string | null;
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
  if (body.productImageUrl !== undefined) patch.productImageUrl = body.productImageUrl ?? '';
  if ((body as { podcastScript?: unknown }).podcastScript !== undefined)
    patch.podcastScript = (body as { podcastScript: unknown }).podcastScript;

  if (!Object.keys(patch).length) return NextResponse.json({ ok: true });
  await ref.update(patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // podcast 任務連帶刪 GCS 音檔，避免孤兒檔案
  if (task.type === 'podcast_generation') {
    try {
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (bucketName) {
        const path = `podcast/${id}.mp3`;
        await getFirebaseAdmin().storage().bucket(bucketName).file(path).delete()
          .catch((e: unknown) => {
            const code = (e as { code?: number })?.code;
            if (code !== 404) console.error('[tasks/delete] GCS delete failed, orphaned file:', path, e);
          });
      }
    } catch (e) { console.error('[tasks/delete] GCS cleanup error:', e); }
  }

  await ref.delete();
  return NextResponse.json({ ok: true });
}
