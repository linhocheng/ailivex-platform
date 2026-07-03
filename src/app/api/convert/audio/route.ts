/**
 * POST /api/convert/audio
 *
 * 素材轉換區「新增口播稿」：用戶手動輸入文字，選擇角色後觸發 TTS 生成音檔。
 * 直接建立 audio_generation task，跳過 script_draft 中介步驟。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type CharacterDoc } from '@/lib/collections';
import { hasAccess } from '@/lib/access';
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

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { text?: string; characterId?: string };
  const text = (body.text ?? '').trim();
  const characterId = (body.characterId ?? '').trim();

  if (!text) return NextResponse.json({ error: 'empty_text' }, { status: 400 });
  if (!characterId) return NextResponse.json({ error: 'missing_character' }, { status: 400 });

  const db = getFirestore();
  if (!await hasAccess(db, user.uid, characterId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: 'character_not_found' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;
  const voiceId = char.voiceIdMinimax ?? '';
  if (!voiceId) return NextResponse.json({ error: 'no_voice' }, { status: 400 });

  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) {
    return NextResponse.json({ error: 'media_worker_not_configured' }, { status: 503 });
  }

  const audioRef = db.collection(COL.tasks).doc();
  const audioTaskId = audioRef.id;
  await audioRef.set({
    userId: user.uid,
    characterId,
    type: 'audio_generation',
    intent: text.slice(0, 60),
    params: { text, voiceId },
    status: 'pending',
    source: 'convert',
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  enqueueAudio(audioTaskId, text, voiceId, char.voiceSettings).catch(err => {
    console.error('[convert/audio] dispatch error:', err);
    audioRef.update({ status: 'failed', error: String(err), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
  });

  return NextResponse.json({ ok: true, taskId: audioTaskId });
}

async function enqueueAudio(
  taskId: string,
  text: string,
  voiceId: string,
  vs?: { speed?: number; pitch?: number; vol?: number; emotion?: string },
): Promise<void> {
  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY! },
    body: JSON.stringify({
      mediaType: 'audio',
      idempotencyKey: taskId,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      // 帶角色的 voiceSettings（音量/語速/音高/情緒），與即時語音同源
      input: {
        text, voiceId,
        speed: vs?.speed ?? 1.0,
        vol: vs?.vol ?? 1.0,
        pitch: vs?.pitch ?? 0,
        emotion: vs?.emotion ?? 'neutral',
      },
      metadata: { taskId },
    }),
  });
  if (!resp.ok) throw new Error(`media-worker ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { jobId: string };
  await getFirestore().collection(COL.tasks).doc(taskId).update({
    status: 'running',
    resultRef: `mw_jobs/${data.jobId}`,
  });
}
