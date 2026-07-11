/**
 * POST /api/convert/podcast/generate-script
 * 建立 task → 立刻委派給 Cloud Run podcast-worker → 回 202 + taskId
 * 前端 poll GET /api/tasks/{id} 等 status=scripted
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { COL, type CharacterDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { podcastJobEnabled, runPodcastJob } from '@/lib/run-podcast-job';

export const runtime = 'nodejs';
export const maxDuration = 30;

const PODCAST_WORKER_URL = cleanUrl(process.env.PODCAST_WORKER_URL ?? '');
const WORKER_SECRET = cleanSecret(process.env.WORKER_SECRET);

// ── Route Handler ─────────────────────────────────────────────────────
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    characterIds?: string[];
    topic?: string;
    wordCount?: number;
    focus?: string;
    episodeGoal?: string; // duo 模式（2 角色）：這一集要回答的問題（磨題產物，人確認過）
  };

  const characterIds = (body.characterIds ?? []).filter(Boolean);
  if (characterIds.length === 0) {
    return NextResponse.json({ error: '請至少選擇一個角色' }, { status: 400 });
  }

  const db = getFirestore();

  for (const cid of characterIds) {
    if (!await hasAccess(db, user.uid, cid)) {
      return NextResponse.json({ error: `forbidden: ${cid}` }, { status: 403 });
    }
  }

  const charSnaps = await Promise.all(characterIds.map(id => db.collection(COL.characters).doc(id).get()));
  const characters = charSnaps
    .map((snap, i) => {
      if (!snap.exists) return null;
      const c = snap.data() as CharacterDoc;
      return { id: characterIds[i], name: c.name };
    })
    .filter(Boolean);

  if (characters.length === 0) return NextResponse.json({ error: '找不到角色' }, { status: 404 });

  const taskRef = db.collection(COL.tasks).doc();
  await taskRef.set({
    userId: user.uid,
    characterId: characters[0]!.id,
    type: 'podcast_generation',
    intent: (body.topic ?? '多角色 Podcast').slice(0, 60),
    params: { characterIds, topic: body.topic, wordCount: body.wordCount, focus: body.focus },
    status: 'running',
    phaseStartedAt: FieldValue.serverTimestamp(),
    notified: false,
    podcastCharacterIds: characterIds,
    podcastTopic: body.topic ?? '',
    ...(body.wordCount ? { podcastWordCount: body.wordCount } : {}),
    ...(body.focus ? { podcastFocus: body.focus } : {}),
    ...(body.episodeGoal?.trim() ? { podcastEpisodeGoal: body.episodeGoal.trim() } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });

  if (podcastJobEnabled()) {
    // 正路：Cloud Run Job（腳本長生成不受 service 閒置回收威脅）。
    // 參數 job 端從 task doc 讀（上面已寫入 podcastCharacterIds 等欄位）。
    try {
      await runPodcastJob(taskRef.id, 'script');
    } catch (err) {
      console.error('[generate-script] job dispatch failed:', err instanceof Error ? err.message : err);
      await taskRef.update({ status: 'failed', error: '派工失敗，請重試' }).catch(() => {});
      return NextResponse.json({ error: 'dispatch failed' }, { status: 502 });
    }
    return NextResponse.json({ taskId: taskRef.id }, { status: 202 });
  }

  if (!PODCAST_WORKER_URL) {
    await taskRef.update({ status: 'failed', error: 'PODCAST_WORKER_URL 未設定' });
    return NextResponse.json({ error: 'worker not configured' }, { status: 503 });
  }

  // 回退路：Fire-and-forget — Cloud Run worker 跑生成，不等結果
  fetch(`${PODCAST_WORKER_URL}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify({
      taskId: taskRef.id,
      characterIds,
      topic: body.topic,
      wordCount: body.wordCount ?? 600,
      focus: body.focus,
      episodeGoal: body.episodeGoal?.trim() || undefined,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(err => {
    console.error('[generate-script] worker dispatch failed:', err instanceof Error ? err.message : err);
    taskRef.update({ status: 'failed', error: '派工失敗，請重試' }).catch(() => {});
  });

  return NextResponse.json({ taskId: taskRef.id }, { status: 202 });
}
