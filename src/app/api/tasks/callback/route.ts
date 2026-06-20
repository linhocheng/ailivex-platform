/**
 * media-worker webhook callback。
 * media-worker 完成 job 後 POST 到這裡，更新 tasks doc。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type TaskDoc } from '@/lib/collections';
import { cleanSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';

type WebhookPayload = {
  event: 'job.completed' | 'job.failed';
  jobId: string;
  mediaType: string;
  metadata?: { taskId?: string };
  result?: { url: string; mimeType: string; sizeBytes?: number };
  error?: string;
};

export async function POST(req: Request) {
  const secret = cleanSecret(req.headers.get('x-webhook-secret'));
  const envSecret = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);
  if (!envSecret || secret !== envSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as WebhookPayload | null;
  if (!body?.metadata?.taskId) return NextResponse.json({ ok: true });

  const { taskId } = body.metadata;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(taskId);

  // 冪等：webhook 可能重送，已收斂的任務不再重寫
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ ok: true });
  const cur = snap.data() as TaskDoc;
  if (cur.status === 'done' || cur.status === 'failed') {
    return NextResponse.json({ ok: true, idempotent: true });
  }

  if (body.event === 'job.completed' && body.result) {
    const summary = buildSummary(body.mediaType, body.result.url);
    const patch: Record<string, unknown> = {
      status: 'done',
      summary,
      completedAt: FieldValue.serverTimestamp(),
    };
    if (body.mediaType === 'image') patch.imageUrl = body.result.url;
    if (body.mediaType === 'audio') patch.audioUrl = body.result.url;
    await ref.update(patch);
  } else if (body.event === 'job.failed') {
    await ref.update({
      status: 'failed',
      error: body.error ?? 'unknown error',
      completedAt: FieldValue.serverTimestamp(),
    });
  }

  return NextResponse.json({ ok: true });
}

function buildSummary(mediaType: string, url: string): string {
  const filename = url.split('/').pop() ?? url;
  switch (mediaType) {
    case 'image': return `圖片已生成完成（${filename}）`;
    case 'audio': return `音檔已生成完成（${filename}）`;
    case 'video': return `影片已生成完成（${filename}）`;
    default: return `任務已完成（${filename}）`;
  }
}
