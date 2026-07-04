/**
 * POST /api/tasks/[id]/generate-images  (Phase C)
 *
 * 對所有 status='scripted' 的子圖卡排隊送 media-worker（逐張）。
 * 圖片 prompt = 瞬 (Shùn) 增強版 prompt，以 cardText 為原料轉譯為專業生圖指令。
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc, type BrandLayoutDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { enhanceImagePrompt } from '@/lib/image-prompt-enhancer';
import { consumeMediaQuota, refundMediaQuota, QuotaExceededError } from '@/lib/quota';

export const runtime = 'nodejs';
export const maxDuration = 120;

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
    // 媒體額度：單張重生扣 1（不足 403）
    try { await consumeMediaQuota(db, user.uid, 1); }
    catch (e) { if (e instanceof QuotaExceededError) return NextResponse.json({ error: 'media_quota_exhausted', message: '媒體生成額度已用罄' }, { status: 403 }); throw e; }
    try {
      await dispatchCard(db, body.cardId, card, imageStyle, layoutImageUrl);
    } catch (e) {
      await refundMediaQuota(db, user.uid, 1);  // 派工同步失敗（無 job，callback 不會來）→ 退回
      throw e;
    }
    return NextResponse.json({ ok: true, count: 1 });
  }

  const scripted = await query.where('status', 'in', ['scripted', 'failed']).get();
  if (scripted.empty) return NextResponse.json({ ok: true, count: 0 });

  // 媒體額度：一次扣 N 張（總量不足 403，不生半套）
  try { await consumeMediaQuota(db, user.uid, scripted.docs.length); }
  catch (e) { if (e instanceof QuotaExceededError) return NextResponse.json({ error: 'media_quota_exhausted', message: `媒體額度不足（本次需 ${scripted.docs.length} 張）` }, { status: 403 }); throw e; }

  // allSettled：每卡獨立。派工同步失敗的那張退回（無 job → callback 不會來）；
  // 成功派工的走 callback 退量（job.failed），兩者互斥不重複退。
  const results = await Promise.allSettled(
    scripted.docs.map(doc =>
      dispatchCard(db, doc.id, doc.data() as TaskDoc & Record<string, unknown>, imageStyle, layoutImageUrl)
    )
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) await refundMediaQuota(db, user.uid, failed);

  return NextResponse.json({ ok: true, count: scripted.docs.length - failed });
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
  const productImageUrl = (card.productImageUrl as string) || '';

  // 瞬 (Shùn) 將 cardText 轉譯為專業生圖 prompt
  const prompt = await enhanceImagePrompt(
    cardText,
    cardType as 'realistic_photo' | 'infographic',
    imageStyle,
    !!productImageUrl,
  );
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
      input: {
        prompt,
        size: '1024x1024',
        outputFormat: 'png',
        referenceImageUrls,
        provider: 'openai',
      },
      metadata: { taskId: cardId },
    }),
  });

  if (!resp.ok) throw new Error(`media-worker ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { jobId: string };
  await ref.update({ status: 'running', resultRef: `mw_jobs/${data.jobId}` });
}
