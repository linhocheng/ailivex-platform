/**
 * DELETE /api/admin/podcasts/[id]
 * Admin 刪任何用戶的 podcast 任務（連帶刪 GCS 音檔，避免孤兒）。
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';

export const runtime = 'nodejs';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (snap.data()?.type !== 'podcast_generation') {
    return NextResponse.json({ error: 'not_podcast' }, { status: 400 });
  }

  try {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (bucketName) {
      const path = `podcast/${id}.mp3`;
      await getFirebaseAdmin().storage().bucket(bucketName).file(path).delete()
        .catch((e: unknown) => {
          const code = (e as { code?: number })?.code;
          if (code !== 404) console.error('[admin/podcasts/delete] GCS delete failed, orphaned file:', path, e);
        });
    }
  } catch (e) { console.error('[admin/podcasts/delete] GCS cleanup error:', e); }

  await ref.delete();
  return NextResponse.json({ ok: true });
}
