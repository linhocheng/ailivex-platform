/**
 * POST /api/admin/characters/[id]/heygen-avatar
 *
 * 接收圖片（binary）
 *   1. 上傳到 HeyGen talking_photo → 取得 talking_photo_id
 *   2. 同時存一份到 GCS（永久 URL）→ 作為 v3 video 的 image 來源
 *   3. 儲存 heygenAvatarId + heygenAvatarUrl 到 character doc
 */
import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { cleanSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';

const HEYGEN_API_KEY = cleanSecret(process.env.HEYGEN_API_KEY);

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id: charId } = await params;
  if (!HEYGEN_API_KEY) return NextResponse.json({ error: 'HEYGEN_API_KEY not set' }, { status: 503 });

  const contentType = req.headers.get('content-type') || 'image/jpeg';
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return NextResponse.json({ error: 'empty_body' }, { status: 400 });

  // 1. 上傳到 HeyGen talking_photo
  const heyResp = await fetch('https://upload.heygen.com/v1/talking_photo', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': contentType },
    body: buf,
  });

  if (!heyResp.ok) {
    const err = await heyResp.text();
    return NextResponse.json({ error: `heygen_upload_failed: ${err.slice(0, 200)}` }, { status: 502 });
  }

  const data = await heyResp.json() as { code: number; data: { talking_photo_id: string; talking_photo_url: string } };
  const talkingPhotoId = data.data?.talking_photo_id;
  if (!talkingPhotoId) return NextResponse.json({ error: 'no_talking_photo_id' }, { status: 502 });

  // 2. 存一份到 GCS → 永久穩定 URL
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const gcsPath = `characters/${charId}/heygen-avatar.${ext}`;
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return NextResponse.json({ error: 'FIREBASE_STORAGE_BUCKET not set' }, { status: 503 });
  const bucket = getFirebaseAdmin().storage().bucket(bucketName);
  const file = bucket.file(gcsPath);
  await file.save(Buffer.from(buf), { contentType, resumable: false });
  const gcsUrl = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;

  // 3. 存進角色 doc
  const db = getFirestore();
  await db.collection(COL.characters).doc(charId).update({
    heygenAvatarId: talkingPhotoId,
    heygenAvatarUrl: gcsUrl,
  });

  return NextResponse.json({ ok: true, talkingPhotoId, previewUrl: gcsUrl });
}
