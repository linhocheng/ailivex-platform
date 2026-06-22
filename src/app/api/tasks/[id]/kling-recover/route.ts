/**
 * POST /api/tasks/[id]/kling-recover
 *
 * 前端偵測到 Kling video task 卡在 running 超過 10 分鐘時呼叫。
 * 主動去 fal.ai 查狀態，補寫結果到 Firestore。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';
import { cleanSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';

const FAL_KEY = cleanSecret(process.env.FAL_KEY);

type FalStatus = {
  status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'IN_QUEUE';
};

type FalResult = {
  video?: { url: string };
};

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(taskId);
  const snap = await ref.get();

  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc & Record<string, unknown>;

  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.source !== 'kling') return NextResponse.json({ error: 'not_kling_task' }, { status: 400 });
  if (task.status !== 'running') return NextResponse.json({ ok: true, status: task.status, skipped: true });

  const falRequestId = task.falRequestId as string | undefined;
  if (!falRequestId) return NextResponse.json({ error: 'no_fal_request_id' }, { status: 400 });
  if (!FAL_KEY) return NextResponse.json({ error: 'fal_not_configured' }, { status: 503 });

  // 查 fal.ai 狀態
  const statusResp = await fetch(
    `https://queue.fal.run/fal-ai/kling-video/requests/${falRequestId}/status`,
    { headers: { Authorization: `Key ${FAL_KEY}` } }
  );
  if (!statusResp.ok) return NextResponse.json({ error: 'fal_status_error', status: statusResp.status }, { status: 502 });

  const falStatus = await statusResp.json() as FalStatus;

  if (falStatus.status === 'COMPLETED') {
    const resultResp = await fetch(
      `https://queue.fal.run/fal-ai/kling-video/requests/${falRequestId}`,
      { headers: { Authorization: `Key ${FAL_KEY}` } }
    );
    if (!resultResp.ok) return NextResponse.json({ error: 'fal_result_error' }, { status: 502 });

    const result = await resultResp.json() as FalResult;
    const videoUrl = result.video?.url;
    if (!videoUrl) return NextResponse.json({ error: 'no_video_url' }, { status: 502 });

    await ref.update({
      status: 'done',
      videoUrl,
      summary: '影片已生成完成（Kling）',
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, status: 'done', videoUrl });
  }

  if (falStatus.status === 'FAILED') {
    await ref.update({
      status: 'failed',
      error: 'fal.ai job failed',
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, status: 'failed' });
  }

  // IN_PROGRESS / IN_QUEUE — 還在跑
  return NextResponse.json({ ok: true, status: 'still_running', falStatus: falStatus.status });
}
