import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type DocumentDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.documents).doc(id);
  const snap = await ref.get();

  if (!snap.exists) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  const doc = snap.data() as DocumentDoc;
  if (doc.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // 刪 GCS 檔案
  if (doc.htmlUrl) {
    try {
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (bucketName) {
        const path = `documents/${user.uid}/${id}.html`;
        await getFirebaseAdmin().storage().bucket(bucketName).file(path).delete()
          .catch((e: unknown) => console.error('[documents/delete] GCS delete failed, orphaned file:', path, e));
      }
    } catch (e) { console.error('[documents/delete] GCS cleanup error:', e); }
  }

  // 刪關聯 job
  const jobSnap = await db.collection(COL.jobs)
    .where('documentId', '==', id)
    .limit(1).get();
  const batch = db.batch();
  jobSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();

  return NextResponse.json({ ok: true });
}
