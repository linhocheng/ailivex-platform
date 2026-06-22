/**
 * POST /api/brands/[characterId]/upload
 * 臨時產品圖上傳（binary body）— 僅存 GCS，不建 Firestore doc
 * headers: content-type (image/jpeg | image/png | image/webp)
 * 回傳: { url }
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';

type Params = { params: Promise<{ characterId: string }> };

export async function POST(req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { characterId } = await params;
  const db = getFirestore();

  const ok = user.role === 'admin' || (await hasAccess(db, user.uid, characterId));
  if (!ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const contentType = req.headers.get('content-type') || 'image/jpeg';
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return NextResponse.json({ error: 'empty_body' }, { status: 400 });

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return NextResponse.json({ error: 'FIREBASE_STORAGE_BUCKET not set' }, { status: 503 });

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const gcsPath = `brand-assets/${characterId}/temp/${randomUUID()}.${ext}`;

  const bucket = getFirebaseAdmin().storage().bucket(bucketName);
  const file = bucket.file(gcsPath);
  await file.save(Buffer.from(buf), { contentType, resumable: false });
  await file.makePublic();
  const url = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;

  return NextResponse.json({ url });
}
