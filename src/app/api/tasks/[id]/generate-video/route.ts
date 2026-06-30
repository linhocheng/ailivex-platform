/**
 * POST /api/tasks/[id]/generate-video
 *
 * 把已完成的 audio_generation task 送給 HeyGen 生成分身短影音。
 * 前置條件：
 *   - task.type === 'audio_generation'
 *   - task.audioUrl 存在
 *   - 角色有 heygenAvatarUrl（專用分身圖）或 avatarUrl（頭像 fallback）
 *
 * 冪等：同一個 audio task 已有 videoTaskId → 直接回傳，不重送 HeyGen。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);

function callbackUrl(): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/callback`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  const body = await req.json().catch(() => ({})) as { motionPrompt?: string; heygenEngine?: string };
  const motionPrompt = typeof body.motionPrompt === 'string' && body.motionPrompt.trim()
    ? body.motionPrompt.trim()
    : undefined;
  const heygenEngine = body.heygenEngine === 'avatar_iii' ? 'avatar_iii' : 'avatar_iv';
  const db = getFirestore();

  const snap = await db.collection(COL.tasks).doc(taskId).get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc & Record<string, unknown>;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.type !== 'audio_generation') return NextResponse.json({ error: 'not_audio_task' }, { status: 400 });
  if (!task.audioUrl) return NextResponse.json({ error: 'no_audio_url' }, { status: 400 });

  // 冪等：已有 videoTaskId → 確認舊 task 狀態，failed 才允許重試
  const existingVideoTaskId = task.videoTaskId as string | undefined;
  if (existingVideoTaskId) {
    const existingSnap = await db.collection(COL.tasks).doc(existingVideoTaskId).get();
    const existingStatus = existingSnap.exists ? (existingSnap.data() as TaskDoc).status : 'failed';
    if (existingStatus !== 'failed') {
      return NextResponse.json({ ok: true, videoTaskId: existingVideoTaskId, idempotent: true });
    }
    // 舊任務已失敗 → 清除 videoTaskId，允許重新派送
    await db.collection(COL.tasks).doc(taskId).update({ videoTaskId: FieldValue.delete() });
  }

  const charSnap = await db.collection(COL.characters).doc(task.characterId as string).get();
  if (!charSnap.exists) return NextResponse.json({ error: 'character_not_found' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  // avatar_iii 引擎需要專屬訓練，無 V3 則降回 avatar_iv
  const resolvedEngine = (heygenEngine === 'avatar_iii' && char.heygenAvatarIdV3)
    ? 'avatar_iii' : 'avatar_iv';
  const avatarImageUrl = char.heygenAvatarUrl || char.avatarUrl;

  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) {
    return NextResponse.json({ error: 'media_worker_not_configured' }, { status: 503 });
  }

  // 建立 video_generation task
  const videoRef = db.collection(COL.tasks).doc();
  await videoRef.set({
    userId: user.uid,
    characterId: task.characterId,
    type: 'video_generation',
    intent: task.intent || '分身短影音',
    params: { avatarUrl: avatarImageUrl, audioUrl: task.audioUrl },
    status: 'pending',
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // 寫 videoTaskId 回 audio task（防止重複送）
  await db.collection(COL.tasks).doc(taskId).update({ videoTaskId: videoRef.id });

  // 送 media-worker
  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY },
    body: JSON.stringify({
      mediaType: 'video',
      idempotencyKey: videoRef.id,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: { avatarUrl: avatarImageUrl, audioUrl: task.audioUrl, motionPrompt, heygenEngine: resolvedEngine },
      metadata: { taskId: videoRef.id },
    }),
  });

  if (!resp.ok) {
    await videoRef.update({ status: 'failed', error: `media-worker ${resp.status}` });
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 502 });
  }

  const data = await resp.json() as { jobId: string };
  await videoRef.update({ status: 'running', resultRef: `mw_jobs/${data.jobId}` });

  return NextResponse.json({ ok: true, videoTaskId: videoRef.id });
}
