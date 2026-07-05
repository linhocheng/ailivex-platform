/**
 * POST /api/tasks/kling-callback?taskId=xxx
 *
 * fal.ai webhook callback。Kling Avatar v2 完成後 POST 到這裡，更新 tasks doc。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type TaskDoc } from '@/lib/collections';
import { refundMediaQuota } from '@/lib/quota';
import { verifyWorkerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';

type FalOutput = {
  video?: { url: string; content_type?: string };
};

type FalWebhookPayload = {
  request_id: string;
  status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'IN_QUEUE';
  output?: FalOutput;
  error?: string | { message?: string };
};

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  // webhook secret（query 帶入，派工時附上）：fail-closed，沒帶或不符一律拒
  if (!verifyWorkerSecret(searchParams.get('ws'), process.env.MEDIA_WORKER_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const taskId = searchParams.get('taskId');
  if (!taskId) return NextResponse.json({ error: 'missing_task_id' }, { status: 400 });

  const body = await req.json().catch(() => null) as FalWebhookPayload | null;
  if (!body) return NextResponse.json({ ok: true });

  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(taskId);

  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ ok: true });
  const cur = snap.data() as TaskDoc;
  if (cur.status === 'done' || cur.status === 'failed') {
    return NextResponse.json({ ok: true, idempotent: true });
  }

  if (body.status === 'COMPLETED' && body.output?.video?.url) {
    await ref.update({
      status: 'done',
      videoUrl: body.output.video.url,
      summary: '影片已生成完成（Kling）',
      completedAt: FieldValue.serverTimestamp(),
    });
  } else if (body.status === 'FAILED') {
    const errMsg = typeof body.error === 'string'
      ? body.error
      : (body.error as { message?: string })?.message ?? 'unknown error';
    await ref.update({
      status: 'failed',
      error: errMsg,
      completedAt: FieldValue.serverTimestamp(),
    });
    // Kling 影片生成失敗 → 退回 1 份媒體額度（冪等 guard 在上，只退一次）
    if (cur.userId) await refundMediaQuota(db, cur.userId, 1);
  }

  return NextResponse.json({ ok: true });
}
