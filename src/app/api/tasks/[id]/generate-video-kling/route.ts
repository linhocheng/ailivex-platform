/**
 * POST /api/tasks/[id]/generate-video-kling
 *
 * 把已完成的 audio_generation task 送給 Kling Avatar v2 生成分身短影音。
 * 自動根據 scriptText 用 Haiku 產生 motion prompt。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

export const runtime = 'nodejs';

const FAL_KEY = cleanSecret(process.env.FAL_KEY);

function callbackUrl(videoTaskId: string): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/kling-callback?taskId=${videoTaskId}`;
}

async function generateMotionPrompt(text: string): Promise<string> {
  try {
    const apiKey = cleanSecret(process.env.ANTHROPIC_API_KEY) ?? '';
    const client = getAnthropicClient(apiKey);
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Based on this script, write ONE short English sentence (max 20 words) describing the speaker's natural body language and expressions for an AI avatar video. Output only the English description.\n\nScript: ${text.slice(0, 400)}`,
      }],
    });
    const c = msg.content[0];
    return c.type === 'text' ? c.text.trim() : fallbackPrompt(text);
  } catch {
    return fallbackPrompt(text);
  }
}

function fallbackPrompt(text: string): string {
  if (text.length < 50) return 'speaks calmly with a warm smile and gentle nod';
  if (text.includes('！') || text.includes('！')) return 'speaks with energy and expressive hand gestures, leaning forward';
  return 'speaks naturally with warm expressions and subtle head movements';
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  const db = getFirestore();

  const snap = await db.collection(COL.tasks).doc(taskId).get();
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc & Record<string, unknown>;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.type !== 'audio_generation') return NextResponse.json({ error: 'not_audio_task' }, { status: 400 });
  if (!task.audioUrl) return NextResponse.json({ error: 'no_audio_url' }, { status: 400 });

  // 冪等：已有 klingVideoTaskId → 確認舊 task 狀態，failed 才允許重試
  const existingKlingTaskId = task.klingVideoTaskId as string | undefined;
  if (existingKlingTaskId) {
    const existingSnap = await db.collection(COL.tasks).doc(existingKlingTaskId).get();
    const existingStatus = existingSnap.exists ? (existingSnap.data() as TaskDoc).status : 'failed';
    if (existingStatus !== 'failed') {
      return NextResponse.json({ ok: true, videoTaskId: existingKlingTaskId, idempotent: true });
    }
    await db.collection(COL.tasks).doc(taskId).update({ klingVideoTaskId: FieldValue.delete() });
  }

  // 查角色，取頭像圖片
  const charSnap = await db.collection(COL.characters).doc(task.characterId as string).get();
  if (!charSnap.exists) return NextResponse.json({ error: 'character_not_found' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;
  const imageUrl = char.heygenAvatarUrl ?? char.avatarUrl;
  if (!imageUrl) return NextResponse.json({ error: 'no_avatar_url' }, { status: 400 });

  if (!FAL_KEY) return NextResponse.json({ error: 'fal_not_configured' }, { status: 503 });

  // 根據腳本文字產生 motion prompt
  const scriptText = ((task.params as Record<string, string>)?.text ?? '').trim();
  const motionPrompt = scriptText
    ? await generateMotionPrompt(scriptText)
    : 'speaks naturally with warm expressions and gentle gestures';

  // 建立 video_generation task
  const videoRef = db.collection(COL.tasks).doc();
  await videoRef.set({
    userId: user.uid,
    characterId: task.characterId,
    type: 'video_generation',
    source: 'kling',
    intent: task.intent || '分身短影音',
    params: { imageUrl, audioUrl: task.audioUrl, motionPrompt },
    status: 'pending',
    notified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // 寫 klingVideoTaskId 回 audio task
  await db.collection(COL.tasks).doc(taskId).update({ klingVideoTaskId: videoRef.id });

  // 送 fal.ai Kling Avatar v2
  const webhook = callbackUrl(videoRef.id);
  const falResp = await fetch(
    `https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard?fal_webhook=${encodeURIComponent(webhook)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        audio_url: task.audioUrl as string,
        prompt: motionPrompt,
      }),
    }
  );

  if (!falResp.ok) {
    const err = await falResp.text().catch(() => falResp.status.toString());
    await videoRef.update({ status: 'failed', error: `fal.ai ${falResp.status}: ${err}` });
    return NextResponse.json({ error: 'fal_dispatch_failed' }, { status: 502 });
  }

  const falData = await falResp.json() as { request_id: string };
  await videoRef.update({ status: 'running', falRequestId: falData.request_id, motionPrompt });

  return NextResponse.json({ ok: true, videoTaskId: videoRef.id, motionPrompt });
}
