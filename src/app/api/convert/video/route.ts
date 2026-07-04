/**
 * POST /api/convert/video
 *
 * 素材轉換區「生成影片」：用戶上傳音檔 + 指定角色 Avatar → 生成 HeyGen 分身短影音。
 *
 * 前置條件（嚴格）：
 *   - 角色必須有 heygenAvatarId，無 fallback
 *
 * 流程：
 *   1. 上傳音檔到 GCS（convert/{userId}/{taskId}.audio）
 *   2. 建立 audio_generation task（status:'done', audioUrl 指向 GCS）
 *   3. 建立 video_generation task + 送 media-worker
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type CharacterDoc } from '@/lib/collections';
import { hasAccess } from '@/lib/access';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { consumeMediaQuota, refundMediaQuota, QuotaExceededError } from '@/lib/quota';

export const runtime = 'nodejs';

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);

function callbackUrl(): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/callback`;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const audioFile = formData.get('audioFile') as File | null;
  const characterId = ((formData.get('characterId') as string) ?? '').trim();
  const heygenEngine = (formData.get('heygenEngine') as string) === 'avatar_iii' ? 'avatar_iii' : 'avatar_iv';

  if (!audioFile || audioFile.size === 0) {
    return NextResponse.json({ error: 'missing_audio_file' }, { status: 400 });
  }
  if (!characterId) {
    return NextResponse.json({ error: 'missing_character' }, { status: 400 });
  }

  const db = getFirestore();
  if (!await hasAccess(db, user.uid, characterId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: 'character_not_found' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  const avatarImageUrl = char.heygenAvatarUrl || char.avatarUrl;
  if (!avatarImageUrl) {
    return NextResponse.json({ error: 'no_heygen_avatar' }, { status: 400 });
  }

  // avatar_iii 引擎需要專屬訓練，無 V3 則降回 avatar_iv
  const resolvedEngine = (heygenEngine === 'avatar_iii' && char.heygenAvatarIdV3)
    ? 'avatar_iii' : 'avatar_iv';

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) {
    return NextResponse.json({ error: 'media_worker_not_configured' }, { status: 503 });
  }

  // 媒體額度：影片扣 1（不足 403，在 GCS 上傳前 fail-fast）
  try { await consumeMediaQuota(db, user.uid, 1); }
  catch (e) { if (e instanceof QuotaExceededError) return NextResponse.json({ error: 'media_quota_exhausted', message: '媒體生成額度已用罄' }, { status: 403 }); throw e; }

  // 預先分配 task ID，作為 GCS 路徑用
  const audioRef = db.collection(COL.tasks).doc();
  const audioTaskId = audioRef.id;

  // 上傳音檔到 GCS
  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const contentType = audioFile.type || 'audio/mpeg';
  const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
  const gcsPath = `convert/${user.uid}/${audioTaskId}.${ext}`;

  const bucket = getFirebaseAdmin().storage().bucket(bucketName);
  const gcsFile = bucket.file(gcsPath);
  await gcsFile.save(buffer, { metadata: { contentType } });
  // bucket 已設 allUsers:objectViewer（uniform bucket-level access），不需 makePublic()
  const audioUrl = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;

  // 建立 audio task（已完成，只作為 audioUrl 容器供 HeyGen 讀取）
  await audioRef.set({
    userId: user.uid,
    characterId,
    type: 'audio_generation',
    intent: `${char.name} 上傳音檔`,
    status: 'done',
    source: 'convert',
    audioUrl,
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
    completedAt: FieldValue.serverTimestamp(),
  });

  // 建立 video task + dispatch HeyGen
  const videoRef = db.collection(COL.tasks).doc();
  await videoRef.set({
    userId: user.uid,
    characterId,
    type: 'video_generation',
    intent: `${char.name} 分身影片`,
    params: { avatarUrl: avatarImageUrl, audioUrl },
    status: 'pending',
    source: 'heygen',
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // 回寫 videoTaskId 到 audio task（防止重複送）
  await audioRef.update({ videoTaskId: videoRef.id });

  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY },
    body: JSON.stringify({
      mediaType: 'video',
      idempotencyKey: videoRef.id,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: { avatarUrl: avatarImageUrl, audioUrl, heygenEngine: resolvedEngine },
      metadata: { taskId: videoRef.id },
    }),
  });

  if (!resp.ok) {
    await videoRef.update({ status: 'failed', error: `media-worker ${resp.status}` });
    await refundMediaQuota(db, user.uid, 1);  // 派工同步失敗（無 job → callback 不會來）→ 退回
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 502 });
  }

  const data = await resp.json() as { jobId: string };
  await videoRef.update({ status: 'running', resultRef: `mw_jobs/${data.jobId}` });

  return NextResponse.json({ ok: true, videoTaskId: videoRef.id });
}
