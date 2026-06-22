/**
 * POST /api/tasks/[id]/generate-images  (Phase C)
 *
 * 對所有 status='scripted' 的子圖卡排隊送 media-worker（逐張）。
 * 圖片 prompt = cardType prefix + imageStyle + cardText（確定性組合，不再呼叫 LLM）。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc, type BrandLayoutDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);

function callbackUrl() {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/callback`;
}

const TYPE_PREFIX: Record<string, string> = {
  realistic_photo: 'Realistic photograph, high quality, ',
  infographic: 'Clean professional infographic design, flat style, ',
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: storyTaskId } = await params;
  const db = getFirestore();

  // 驗 story_draft ownership
  const storySnap = await db.collection(COL.tasks).doc(storyTaskId).get();
  if (!storySnap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const storyTask = storySnap.data() as TaskDoc & Record<string, unknown>;
  if (storyTask.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // 取角色 imageStyle + 全版 Layout URL
  let imageStyle = '';
  let layoutImageUrl = '';
  if (storyTask.characterId) {
    const cs = await db.collection(COL.characters).doc(storyTask.characterId as string).get();
    if (cs.exists) imageStyle = (cs.data() as CharacterDoc).imageStyle ?? '';
  }
  if (storyTask.brandLayoutId) {
    const ls = await db.collection(COL.brandLayouts).doc(storyTask.brandLayoutId as string).get();
    if (ls.exists) layoutImageUrl = (ls.data() as BrandLayoutDoc).imageUrl ?? '';
  }

  // 讀所有 scripted 子卡（可能含單張重新生成：status='failed' 也允許重試）
  const body = await req.json().catch(() => ({})) as { cardId?: string };
  let query = db.collection(COL.tasks).where('parentTaskId', '==', storyTaskId);
  if (body.cardId) {
    // 單張重生：只處理指定卡
    const cardSnap = await db.collection(COL.tasks).doc(body.cardId).get();
    if (!cardSnap.exists || cardSnap.data()?.userId !== user.uid) {
      return NextResponse.json({ error: 'card_not_found' }, { status: 404 });
    }
    const card = cardSnap.data() as TaskDoc & Record<string, unknown>;
    await dispatchCard(db, body.cardId, card, imageStyle, layoutImageUrl);
    return NextResponse.json({ ok: true, count: 1 });
  }

  const scripted = await query.where('status', 'in', ['scripted', 'failed']).get();
  if (scripted.empty) return NextResponse.json({ ok: true, count: 0 });

  let dispatched = 0;
  for (const doc of scripted.docs) {
    await dispatchCard(db, doc.id, doc.data() as TaskDoc & Record<string, unknown>, imageStyle, layoutImageUrl);
    dispatched++;
  }

  return NextResponse.json({ ok: true, count: dispatched });
}

async function dispatchCard(
  db: FirebaseFirestore.Firestore,
  cardId: string,
  card: TaskDoc & Record<string, unknown>,
  imageStyle: string,
  layoutImageUrl: string,
) {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) {
    throw new Error('MEDIA_WORKER_URL or MEDIA_WORKER_KEY_AILIVEX not set');
  }

  const cardType = (card.cardType as string) || 'realistic_photo';
  const cardText = (card.cardText as string) || (card.intent as string) || '';
  const prefix = TYPE_PREFIX[cardType] || '';
  const styleStr = imageStyle ? `${imageStyle}, ` : '';
  const prompt = `${prefix}${styleStr}${cardText}`.trim();

  // 組 referenceImageUrls：全版 Layout + 卡片產品圖
  const productImageUrl = (card.productImageUrl as string) || '';
  const referenceImageUrls = [layoutImageUrl, productImageUrl].filter(Boolean);

  const ref = db.collection(COL.tasks).doc(cardId);
  await ref.update({ status: 'pending', imageUrl: FieldValue.delete() });

  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_WORKER_KEY! },
    body: JSON.stringify({
      mediaType: 'image',
      idempotencyKey: `${cardId}-${Date.now()}`,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: { prompt, size: '1024x1024', outputFormat: 'png', referenceImageUrls },
      metadata: { taskId: cardId },
    }),
  });

  if (!resp.ok) throw new Error(`media-worker ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { jobId: string };
  await ref.update({ status: 'running', resultRef: `mw_jobs/${data.jobId}` });
}
