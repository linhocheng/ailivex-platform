/**
 * POST /api/convert/podcast/retry
 * 重啟一個 failed 的 podcast task：無腳本→重跑腳本生成、有腳本→重跑音檔生成。
 * 參數 job 端從 task doc 讀（generate-script 建立時已寫入 podcastCharacterIds 等欄位）。
 * Body: { taskId: string }
 * Returns: 202 { accepted: true, taskId, action }
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { podcastJobEnabled, runPodcastJob } from '@/lib/run-podcast-job';

export const runtime = 'nodejs';
export const maxDuration = 30;

const PODCAST_WORKER_URL = cleanUrl(process.env.PODCAST_WORKER_URL ?? '');
const WORKER_SECRET = cleanSecret(process.env.WORKER_SECRET);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { taskId?: string };
  const taskId = (body.taskId ?? '').trim();
  if (!taskId) return NextResponse.json({ error: 'taskId 必填' }, { status: 400 });

  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'task not found' }, { status: 404 });

  const task = snap.data() as TaskDoc & { audioUrl?: string };
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.type !== 'podcast_generation') return NextResponse.json({ error: 'not a podcast task' }, { status: 400 });
  // running 不給重啟——已在跑的任務再派一顆 Job 會雙跑雙燒；逾時殭屍由 scripts GET 驗屍轉 failed 後才可重啟
  if (task.status === 'running') return NextResponse.json({ error: 'already_running' }, { status: 409 });

  const script = task.podcastScript ?? [];
  const action: 'script' | 'audio' = script.length > 0 ? 'audio' : 'script';

  await ref.update({
    status: 'running',
    error: FieldValue.delete(),
    podcastPhase: action === 'audio' ? 'audio_pending' : 'script_pending',
    phaseStartedAt: FieldValue.serverTimestamp(),
  });

  if (podcastJobEnabled()) {
    try {
      await runPodcastJob(taskId, action);
    } catch (err) {
      console.error('[podcast-retry] job dispatch failed:', err instanceof Error ? err.message : err);
      await ref.update({ status: 'failed', error: '重啟派工失敗，請再試一次' }).catch(() => {});
      return NextResponse.json({ error: 'dispatch failed' }, { status: 502 });
    }
    return NextResponse.json({ accepted: true, taskId, action }, { status: 202 });
  }

  // 回退路：舊 worker service（拔 PODCAST_JOB_NAME 時生效）
  if (!PODCAST_WORKER_URL || !WORKER_SECRET) {
    await ref.update({ status: 'failed', error: 'worker 未設定' }).catch(() => {});
    return NextResponse.json({ error: 'worker not configured' }, { status: 503 });
  }
  const params = (task as { params?: { characterIds?: string[]; topic?: string; wordCount?: number; focus?: string } }).params ?? {};
  const endpoint = action === 'audio' ? `${PODCAST_WORKER_URL}/run-audio` : `${PODCAST_WORKER_URL}/run`;
  const payload = action === 'audio'
    ? { taskId, script }
    : { taskId, characterIds: params.characterIds ?? task.podcastCharacterIds ?? [], topic: params.topic ?? task.podcastTopic, wordCount: params.wordCount ?? 600, focus: params.focus };
  fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).catch(err => {
    if (err?.name !== 'TimeoutError' && err?.name !== 'AbortError') {
      console.error('[podcast-retry] dispatch error:', err);
      ref.update({ status: 'failed', error: '重啟派工失敗，請再試一次' }).catch(() => {});
    }
  });

  return NextResponse.json({ accepted: true, taskId, action }, { status: 202 });
}
