/**
 * POST /api/tasks/[id]/generate-audio
 *
 * 用戶在媒體庫審閱腳本草稿後，按「生成音檔」觸發此 endpoint。
 * 讀取 script_draft task → 拿 voiceId（優先用角色設定）→ 建 audio_generation task → dispatch media-worker。
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  const body = await req.json().catch(() => ({})) as { text?: string };

  const db = getFirestore();
  const draftRef = db.collection(COL.tasks).doc(taskId);
  const draftSnap = await draftRef.get();

  if (!draftSnap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const draft = draftSnap.data() as TaskDoc;

  if (draft.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (draft.type !== 'script_draft') return NextResponse.json({ error: 'not_a_script_draft' }, { status: 400 });

  // 優先用前端傳來的（用戶可能編修過），fallback 到 draft 裡存的
  const scriptText = (body.text ?? draft.scriptText ?? '').trim();
  if (!scriptText) return NextResponse.json({ error: 'empty_text' }, { status: 400 });

  // 取角色 voiceId（draft 存了 agent 當時的 voice_id，也可從 character doc 讀最新值）
  let voiceId = draft.voiceId ?? '';
  if (!voiceId && draft.characterId) {
    const charSnap = await db.collection(COL.characters).doc(draft.characterId).get();
    if (charSnap.exists) {
      voiceId = (charSnap.data() as CharacterDoc).voiceIdMinimax ?? '';
    }
  }

  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) {
    return NextResponse.json({ error: 'media_worker_not_configured' }, { status: 503 });
  }

  // 建新的 audio_generation task
  const audioRef = db.collection(COL.tasks).doc();
  const audioTaskId = audioRef.id;
  await audioRef.set({
    userId: user.uid,
    characterId: draft.characterId,
    type: 'audio_generation',
    intent: draft.intent,
    params: { text: scriptText, voiceId },
    status: 'pending',
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // dispatch media-worker（非同步，不等）
  enqueueAudio(audioTaskId, scriptText, voiceId).catch(err => {
    console.error('[generate-audio] dispatch error:', err);
    audioRef.update({ status: 'failed', error: String(err), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
  });

  return NextResponse.json({ ok: true, audioTaskId });
}

async function enqueueAudio(taskId: string, text: string, voiceId: string): Promise<void> {
  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY! },
    body: JSON.stringify({
      mediaType: 'audio',
      idempotencyKey: taskId,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: { text, voiceId, speed: 1.0, vol: 1.0, pitch: 0, emotion: 'neutral' },
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
