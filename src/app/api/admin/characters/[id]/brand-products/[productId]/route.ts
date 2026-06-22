/**
 * DELETE /api/admin/characters/[id]/brand-products/[productId] — 刪除（Firestore + GCS）
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type BrandProductDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; productId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (user?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { id: characterId, productId } = await params;
  const db = getFirestore();

  const snap = await db.collection(COL.brandProducts).doc(productId).get();
  if (!snap.exists || (snap.data() as BrandProductDoc).characterId !== characterId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const { imageUrl } = snap.data() as BrandProductDoc;

  // 刪 GCS
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (bucketName && imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      const gcsPath = parsed.pathname.split('/').slice(2).join('/');
      await getFirebaseAdmin().storage().bucket(bucketName).file(gcsPath).delete();
    } catch (e) {
      console.error('[brand-products] GCS delete failed:', e);
    }
  }

  await snap.ref.delete();
  return NextResponse.json({ ok: true });
}
