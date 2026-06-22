/**
 * PATCH  /api/admin/characters/[id]/brand-layouts/[layoutId] — 設為預設
 * DELETE /api/admin/characters/[id]/brand-layouts/[layoutId] — 刪除（Firestore + GCS）
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type BrandLayoutDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; layoutId: string }> };

export async function PATCH(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (user?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { id: characterId, layoutId } = await params;
  const db = getFirestore();

  const snap = await db.collection(COL.brandLayouts).doc(layoutId).get();
  if (!snap.exists || (snap.data() as BrandLayoutDoc).characterId !== characterId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 清除同角色其他 isDefault，再設這個
  const existing = await db.collection(COL.brandLayouts)
    .where('characterId', '==', characterId)
    .where('isDefault', '==', true)
    .get();
  const batch = db.batch();
  existing.docs.forEach(d => batch.update(d.ref, { isDefault: false }));
  batch.update(snap.ref, { isDefault: true });
  await batch.commit();

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (user?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { id: characterId, layoutId } = await params;
  const db = getFirestore();

  const snap = await db.collection(COL.brandLayouts).doc(layoutId).get();
  if (!snap.exists || (snap.data() as BrandLayoutDoc).characterId !== characterId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const { imageUrl } = snap.data() as BrandLayoutDoc;

  // 刪 GCS
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (bucketName && imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      const gcsPath = parsed.pathname.split('/').slice(2).join('/');
      await getFirebaseAdmin().storage().bucket(bucketName).file(gcsPath).delete();
    } catch (e) {
      console.error('[brand-layouts] GCS delete failed:', e);
    }
  }

  await snap.ref.delete();
  return NextResponse.json({ ok: true });
}
