/**
 * DELETE /api/gallery/[id] —— 刪圖 / 取消任務 / 刪失敗任務，三者同一操作：
 * 把這個 task 從「根本源頭」整串清掉，不只是 UI 隱藏（避免假中台殘留）：
 *   1. GCS 圖片檔（imageUrl 指的真實物件）
 *   2. media-worker 的 mw_jobs 紀錄（resultRef 指的 job ledger）
 *   3. 平台自己的 tasks doc
 *
 * pending/running 刪除 = 取消：webhook callback 對不存在的 task 已經是 no-op（冪等），
 * 故 media-worker 之後就算回呼也不會復活這筆。
 */
import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

// 從 GCS 公開網址反解 bucket + object，支援 path-style 與 virtual-hosted 兩種。
function parseGcsUrl(url: string): { bucket: string; object: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'storage.googleapis.com') {
      const parts = u.pathname.replace(/^\//, '').split('/');
      const bucket = parts.shift() ?? '';
      const object = decodeURIComponent(parts.join('/'));
      if (bucket && object) return { bucket, object };
    } else if (u.hostname.endsWith('.storage.googleapis.com')) {
      const bucket = u.hostname.replace('.storage.googleapis.com', '');
      const object = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (bucket && object) return { bucket, object };
    }
  } catch { /* 非合法網址，當作沒有檔案可刪 */ }
  return null;
}

export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(id);
  const snap = await ref.get();

  if (!snap.exists) return NextResponse.json({ error: '任務不存在' }, { status: 404 });
  const task = snap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const warnings: string[] = [];

  // 1. 刪 GCS 圖片檔（根本源頭）。失敗要吼，不靜默吞 —— 否則檔案孤兒留在 bucket 就是假中台。
  if (task.imageUrl) {
    const loc = parseGcsUrl(task.imageUrl);
    if (loc) {
      try {
        await getFirebaseAdmin().storage().bucket(loc.bucket).file(loc.object).delete();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 404（檔案本就不在）視為已刪；其他錯誤記下並回報
        if (!/No such object|404/i.test(msg)) {
          console.error(`[gallery delete] GCS 刪除失敗 task=${id} object=${loc.object}:`, msg);
          warnings.push('image-file');
        }
      }
    }
  }

  // 2. 刪 media-worker 的 mw_jobs 紀錄（resultRef = "mw_jobs/<jobId>"）
  // 3. 刪平台 tasks doc —— 兩個 Firestore 刪除用 batch 一起收斂
  const batch = db.batch();
  if (task.resultRef?.startsWith('mw_jobs/')) {
    const jobId = task.resultRef.slice('mw_jobs/'.length);
    if (jobId) batch.delete(db.collection('mw_jobs').doc(jobId));
  }
  batch.delete(ref);
  await batch.commit();

  return NextResponse.json({ ok: true, warnings });
}
