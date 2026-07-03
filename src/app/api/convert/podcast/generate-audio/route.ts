/**
 * POST /api/convert/podcast/generate-audio
 * 派工到 Cloud Run podcast-worker /run-audio（fire-and-forget）。
 * 長腳本的逐句 TTS 會超過 Vercel 300s 上限，生成本體在 worker 跑；
 * 前端輪詢 GET /api/tasks/{id} 等 status=done 拿 audioUrl。
 * Body: { taskId: string; script?: PodcastLine[] }
 * Returns: 202 { accepted: true, taskId }
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type PodcastLine } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 30;

const PODCAST_WORKER_URL = cleanUrl(process.env.PODCAST_WORKER_URL ?? '');
const WORKER_SECRET = cleanSecret(process.env.WORKER_SECRET);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    taskId?: string;
    script?: PodcastLine[];
  };

  const taskId = (body.taskId ?? '').trim();
  if (!taskId) return NextResponse.json({ error: 'taskId 必填' }, { status: 400 });

  const db = getFirestore();
  const taskSnap = await db.collection(COL.tasks).doc(taskId).get();
  if (!taskSnap.exists) return NextResponse.json({ error: 'task not found' }, { status: 404 });

  const task = taskSnap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.type !== 'podcast_generation') return NextResponse.json({ error: 'not a podcast task' }, { status: 400 });

  const script: PodcastLine[] = body.script?.length ? body.script : (task.podcastScript ?? []);
  if (script.length === 0) return NextResponse.json({ error: '尚未有腳本' }, { status: 400 });

  if (!PODCAST_WORKER_URL || !WORKER_SECRET) {
    return NextResponse.json({ error: 'worker 未設定' }, { status: 503 });
  }

  // 先標 running，讓腳本庫立刻顯示「生成中」
  await taskSnap.ref.update({ status: 'running', podcastPhase: 'audio_pending' });

  fetch(`${PODCAST_WORKER_URL}/run-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify({ taskId, script: body.script?.length ? body.script : undefined }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => {
    if (!r.ok && r.status !== 202) {
      console.error(`[generate-audio] worker dispatch ${r.status}`);
      taskSnap.ref.update({ status: 'failed', error: '音檔派工失敗，請重試' }).catch(() => {});
    }
  }).catch(err => {
    // 10s abort 是預期行為（worker 已收到 202 就好）；真正連不上才標失敗
    if (err?.name !== 'TimeoutError' && err?.name !== 'AbortError') {
      console.error('[generate-audio] dispatch error:', err);
      taskSnap.ref.update({ status: 'failed', error: '音檔派工失敗，請重試' }).catch(() => {});
    }
  });

  return NextResponse.json({ accepted: true, taskId }, { status: 202 });
}
