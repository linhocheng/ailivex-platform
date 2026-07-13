/**
 * 對話錄音管理（admin）。
 *
 * GET：先 reconcile 兜底對帳（webhook 漏接也能收帳），再列最近 100 筆；
 *      done 的附 4 小時 signed URL（錄音是私人資料，不走公開連結；
 *      MP4 走 GCS 原生 Range 206，iOS 可播）。
 * DELETE ?room=<roomName>：刪 GCS 檔＋doc（先刪檔再刪帳，檔刪失敗帳還在可重試）。
 */
import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { COL, type RecordingDoc } from '@/lib/collections';
import { reconcileRecordings } from '@/lib/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getFirestore();
  await reconcileRecordings(db);

  const snap = await db.collection(COL.recordings)
    .orderBy('createdAt', 'desc').limit(100).get();

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const bucket = bucketName ? getFirebaseAdmin().storage().bucket(bucketName) : null;

  const expires = Date.now() + 4 * 60 * 60 * 1000;
  const rows = await Promise.all(snap.docs.map(async d => {
    const r = d.data() as RecordingDoc;
    let url = '';
    let condensedUrl = '';
    if (r.status === 'done' && bucket) {
      try {
        const [signed] = await bucket.file(r.filepath).getSignedUrl({ action: 'read', expires });
        url = signed;
        if (r.condensedFilepath) {
          const [signedC] = await bucket.file(r.condensedFilepath).getSignedUrl({ action: 'read', expires });
          condensedUrl = signedC;
        }
      } catch { /* 簽失敗就不給連結，列表照出 */ }
    }
    const createdAt = r.createdAt instanceof Date ? r.createdAt : r.createdAt.toDate();
    return {
      roomName: r.roomName, characterId: r.characterId, characterName: r.characterName,
      userId: r.userId, status: r.status,
      durationSec: r.durationSec ?? null, sizeBytes: r.sizeBytes ?? null,
      createdAt: createdAt.toISOString(), url,
      condensedUrl, condensedSizeBytes: r.condensedSizeBytes ?? null,
    };
  }));

  return NextResponse.json({ recordings: rows });
}

export async function DELETE(req: Request) {
  const room = new URL(req.url).searchParams.get('room')?.trim();
  if (!room) return NextResponse.json({ error: 'room 必填' }, { status: 400 });

  const db = getFirestore();
  const ref = db.collection(COL.recordings).doc(room);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '不存在' }, { status: 404 });
  const r = snap.data() as RecordingDoc;

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (bucketName && r.filepath) {
    // 檔可能不存在（failed 的通話）——ignoreNotFound 冪等；濃縮版一併清
    const bucket = getFirebaseAdmin().storage().bucket(bucketName);
    await bucket.file(r.filepath).delete({ ignoreNotFound: true });
    if (r.condensedFilepath) {
      await bucket.file(r.condensedFilepath).delete({ ignoreNotFound: true });
    }
  }
  await ref.delete();
  return NextResponse.json({ ok: true });
}
