/**
 * POST /api/tasks/[id]/generate-storyboard
 *
 * 用戶在媒體庫審閱故事草稿後，按「生成圖卡」觸發此 endpoint。
 * 流程：
 *   1. 讀 story_draft task（auth + type check）
 *   2. 讀角色 imageStyle
 *   3. 呼叫 LLM（bridge-preferred）分析故事 → N 張圖的 prompt 清單
 *   4. 批次建立 N 個 image_generation tasks（parentTaskId + order）
 *   5. 非同步送 media-worker（逐一排隊，完成一張再下一張由 queue 保證）
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc } from '@/lib/collections';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);
const IMAGE_SIZE = '1024x1024';

function callbackUrl(): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/callback`;
}

interface ImageSlot { order: number; title: string; prompt: string; }

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  const body = await req.json().catch(() => ({})) as { text?: string; addOne?: boolean; prompt?: string; intent?: string; cardType?: string };

  const db = getFirestore();
  const draftRef = db.collection(COL.tasks).doc(taskId);
  const draftSnap = await draftRef.get();

  if (!draftSnap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const draft = draftSnap.data() as TaskDoc & Record<string, unknown>;
  if (draft.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (draft.type !== 'story_draft') return NextResponse.json({ error: 'not_a_story_draft' }, { status: 400 });

  // addOne：單獨新增一張圖到故事板（用戶手動加）
  if (body.addOne && body.prompt?.trim()) {
    const existingSnap = await db.collection(COL.tasks)
      .where('userId', '==', user.uid)
      .where('parentTaskId', '==', taskId)
      .get();
    const nextOrder = existingSnap.size + 1;
    const cardType = body.cardType || 'realistic_photo';
    const cardText = body.prompt.trim();
    const intent = body.intent?.trim() || cardText;
    const imgRef = db.collection(COL.tasks).doc();
    await imgRef.set({
      userId: user.uid,
      characterId: draft.characterId,
      type: 'image_generation',
      intent,
      params: { prompt: cardText, size: IMAGE_SIZE },
      status: 'pending',
      parentTaskId: taskId,
      order: nextOrder,
      cardText,
      cardType,
      notified: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    enqueueImage(imgRef.id, body.prompt.trim()).catch(err => {
      console.error(`[generate-storyboard] addOne error task=${imgRef.id}:`, err);
      imgRef.update({ status: 'failed', error: String(err), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
    return NextResponse.json({ ok: true, count: 1, taskIds: [imgRef.id] });
  }

  const storyText = (body.text ?? (draft.storyText as string) ?? '').trim();
  if (!storyText) return NextResponse.json({ error: 'empty_text' }, { status: 400 });

  // 取角色 imageStyle
  let imageStyle = '';
  if (draft.characterId) {
    const charSnap = await db.collection(COL.characters).doc(draft.characterId as string).get();
    if (charSnap.exists) {
      imageStyle = (charSnap.data() as CharacterDoc).imageStyle ?? '';
    }
  }

  // LLM 分析：故事 → N 張圖 prompt 清單
  const slots = await analyzeStory(storyText, imageStyle);
  if (!slots.length) return NextResponse.json({ error: 'llm_returned_empty' }, { status: 500 });

  // 批次建立 image_generation tasks（parentTaskId 指向 story_draft）
  const taskIds: string[] = [];
  for (const slot of slots) {
    const imgRef = db.collection(COL.tasks).doc();
    await imgRef.set({
      userId: user.uid,
      characterId: draft.characterId,
      type: 'image_generation',
      intent: slot.title,
      params: { prompt: slot.prompt, size: IMAGE_SIZE },
      status: 'pending',
      parentTaskId: taskId,
      order: slot.order,
      notified: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    taskIds.push(imgRef.id);

    // 逐一 fire-and-forget（media-worker 內部 queue 保證串行）
    enqueueImage(imgRef.id, slot.prompt).catch(err => {
      console.error(`[generate-storyboard] dispatch error task=${imgRef.id}:`, err);
      imgRef.update({ status: 'failed', error: String(err), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
  }

  return NextResponse.json({ ok: true, count: slots.length, taskIds });
}

async function analyzeStory(story: string, imageStyle: string): Promise<ImageSlot[]> {
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY ?? '');
  const styleHint = imageStyle ? `角色設定的圖片風格：${imageStyle}。` : '';

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: (
      '你是一位視覺故事板規劃師。根據給定的故事文字，決定需要幾張圖片（3到12張）才能完整說完這個故事，'
      + '並為每張圖片寫一個詳細的英文生圖 prompt。'
      + '圖片可以是寫實照片、插畫、資訊圖表——依故事內容和風格決定。'
      + '輸出格式：在 <result> 標籤內放 JSON 陣列，每個元素含 order（從1開始）、title（中文標題）、prompt（英文生圖描述）。'
      + '只輸出 <result> 標籤和 JSON，不要其他文字。'
    ),
    messages: [{
      role: 'user',
      content: (
        `故事內容：\n${story}\n\n${styleHint}`
        + '請分析這個故事，決定需要幾張圖片，並為每張圖片規劃畫面。\n\n'
        + '<result>[{"order":1,"title":"場景標題","prompt":"detailed English image generation prompt"},...]</result>'
      ),
    }],
  });

  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  const match = text.match(/<result>([\s\S]*?)<\/result>/);
  if (!match) throw new Error('LLM did not return <result> block');

  const parsed = JSON.parse(match[1].trim()) as unknown[];
  return parsed
    .filter((s): s is ImageSlot =>
      typeof s === 'object' && s !== null &&
      typeof (s as Record<string, unknown>).order === 'number' &&
      typeof (s as Record<string, unknown>).prompt === 'string' &&
      ((s as Record<string, unknown>).prompt as string).trim().length > 0
    )
    .sort((a, b) => a.order - b.order);
}

async function enqueueImage(taskId: string, prompt: string): Promise<void> {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) throw new Error('MEDIA_WORKER_URL or MEDIA_WORKER_KEY_AILIVEX not set');

  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY },
    body: JSON.stringify({
      mediaType: 'image',
      idempotencyKey: taskId,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: { prompt, size: IMAGE_SIZE, outputFormat: 'png' },
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
