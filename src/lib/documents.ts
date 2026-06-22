/**
 * 文件 job — 角色在對話中用 [[DOCUMENT]] 叫出。
 * 建 Firestore 後 fire-and-forget 打 /api/doc-process（Vercel 內部 route，走 bridge 吃到飽）。
 * 原 Cloud Tasks → Cloud Run 鏈路已廢棄（enqueue 從 Vercel 靜默失敗）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import * as opencc from 'opencc-js';
import { COL, type DocumentDoc, type JobDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

const toTraditional = opencc.Converter({ from: 'cn', to: 'tw' });

export async function createDocumentJob(
  db: Firestore,
  userId: string,
  characterId: string,
  title: string,
  brief: string,
): Promise<{ documentId: string; jobId: string }> {
  const docRef = db.collection(COL.documents).doc();
  const document: DocumentDoc = {
    userId,
    characterId,
    title: toTraditional(title),
    status: 'pending',
    createdAt: new Date(),
  };
  await docRef.set(document);

  const jobRef = db.collection(COL.jobs).doc();
  const job: JobDoc = {
    userId,
    characterId,
    type: 'document',
    brief,
    documentId: docRef.id,
    status: 'pending',
    createdAt: new Date(),
  };
  await jobRef.set(job);

  return { documentId: docRef.id, jobId: jobRef.id };
}

// env 值若用 echo / 複製貼上設定，常會夾帶尾端「字面 \n」（反斜線+n 兩個字元，不是真換行）
// 或多餘空白。.trim() 只吃得掉真空白，吃不掉字面 \n —— 污染的 URL 會讓 fetch 直接拋錯，
// 被下面的 catch 靜默吞掉，job 永遠停在 pending（= 文件「卡住」）。URL 與 secret 內部本來
// 就不含空白，整串洗掉最穩，dispatch 不受 env 怎麼設的影響。
export async function dispatchDocumentJob(jobId: string): Promise<void> {
  // Cloud Run worker takes priority; falls back to Vercel self-call (/api/doc-process)
  const cloudRunUrl = cleanUrl(process.env.CLOUD_RUN_DOC_WORKER_URL);
  const endpoint = cloudRunUrl
    ? cloudRunUrl
    : `${process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')}/api/doc-process`;
  const workerSecret = cleanSecret(process.env.WORKER_SECRET);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerSecret ? { 'x-worker-secret': workerSecret } : {}),
      },
      body: JSON.stringify({ jobId }),
    });
    // 非 2xx 不會讓 fetch reject —— 不檢查就會跟「字面 \n」一樣靜默卡死。出錯要吼。
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[documents] dispatch non-2xx:', jobId, 'endpoint=', endpoint, 'status=', r.status, body.slice(0, 200));
    }
  } catch (e) {
    console.error('[documents] dispatch failed:', jobId, 'endpoint=', endpoint, e instanceof Error ? e.message : String(e));
  }
}
