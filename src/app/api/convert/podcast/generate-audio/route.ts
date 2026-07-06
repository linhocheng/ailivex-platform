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
import { loadPatterns, scanText, rewriteFlagged } from '@/lib/text-filter';
import { toTraditional } from '@/lib/zh-convert';
import { podcastJobEnabled, runPodcastJob } from '@/lib/run-podcast-job';

export const runtime = 'nodejs';
export const maxDuration = 120; // 逐句過濾改寫可能吃掉數十秒

const PODCAST_WORKER_URL = cleanUrl(process.env.PODCAST_WORKER_URL ?? '');
const WORKER_SECRET = cleanSecret(process.env.WORKER_SECRET);
const BRIDGE_ENDPOINT = `${cleanUrl((process.env.BRIDGE_URL ?? '').replace(/\/v1\/messages\/?$/, ''))}/v1/messages`;
const BRIDGE_SECRET = cleanSecret(process.env.BRIDGE_SECRET);

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

  // 出口是機器（音檔，沒有人再看一眼）：逐句 轉繁→句型過濾改寫→轉繁；只改寫踩雷句省呼叫
  let filteredScript: PodcastLine[] = script;
  try {
    const patterns = await loadPatterns(db);
    let flagged = 0;
    filteredScript = [];
    for (const line of script) {
      let text = toTraditional(line.text || '');
      const hits = scanText(text, patterns);
      if (hits.length > 0) {
        flagged++;
        text = toTraditional(await rewriteFlagged(text, hits, BRIDGE_ENDPOINT, BRIDGE_SECRET));
      }
      filteredScript.push({ ...line, text });
    }
    if (flagged > 0) console.log(`[text-filter] podcast 腳本 ${flagged}/${script.length} 句踩雷，已改寫`);
  } catch (fe) {
    console.warn('[text-filter] podcast 過濾失敗，原稿送 worker:', fe);
    filteredScript = script;
  }

  // 先標 running，讓腳本庫立刻顯示「生成中」；podcastScript 同步存過濾後版本（音檔=紀錄，真相一致）
  await taskSnap.ref.update({ status: 'running', podcastPhase: 'audio_pending', podcastScript: filteredScript });

  if (podcastJobEnabled()) {
    // 正路：Cloud Run Job（長 TTS 不受 service 閒置回收威脅）。
    // 過濾後 script 已寫回 task doc（上一行），job 端讀 doc。
    try {
      await runPodcastJob(taskId, 'audio');
    } catch (err) {
      console.error('[generate-audio] job dispatch failed:', err instanceof Error ? err.message : err);
      await taskSnap.ref.update({ status: 'failed', error: '音檔派工失敗，請重試' }).catch(() => {});
      return NextResponse.json({ error: 'dispatch failed' }, { status: 502 });
    }
    return NextResponse.json({ accepted: true, taskId }, { status: 202 });
  }

  fetch(`${PODCAST_WORKER_URL}/run-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify({ taskId, script: filteredScript }),
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
