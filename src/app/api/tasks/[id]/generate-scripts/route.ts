/**
 * POST /api/tasks/[id]/generate-scripts  (Phase B)
 *
 * 讀取 storyText → LLM 分析 → 產出 N 張圖卡腳本（cardText + cardType）。
 * 在 Firestore 建立 N 個 image_generation tasks（status='scripted'）。
 * 完成後 story_draft status → 'ready'。
 */
import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc } from '@/lib/collections';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { cleanSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 180;

interface CardSlot { order: number; title: string; cardText: string; cardType: 'realistic_photo' | 'infographic'; }

async function isAuthorized(req: Request, userId: string): Promise<boolean> {
  const workerSecret = cleanSecret(req.headers.get('x-worker-secret'));
  const expectedSecret = cleanSecret(process.env.WORKER_SECRET);
  if (expectedSecret && workerSecret === expectedSecret) return true;
  const user = await getCurrentUser();
  return user?.uid === userId;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc(taskId);
  const snap = await ref.get();

  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const task = snap.data() as TaskDoc & Record<string, unknown>;
  if (task.type !== 'story_draft') return NextResponse.json({ error: 'not_a_story_draft' }, { status: 400 });
  if (!await isAuthorized(req, task.userId)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const storyText = (task.storyText as string) || '';
  if (!storyText.trim()) return NextResponse.json({ error: 'no_story_text' }, { status: 400 });

  // 快速回 200，LLM 分析在 after() 裡執行
  after(async () => {
    // 取角色 imageStyle
    let imageStyle = '';
    if (task.characterId) {
      const cs = await db.collection(COL.characters).doc(task.characterId as string).get();
      if (cs.exists) imageStyle = (cs.data() as CharacterDoc).imageStyle ?? '';
    }

    try {
      const cards = await analyzeStory(storyText, imageStyle);
      if (!cards.length) throw new Error('LLM returned empty card list');

      // 刪除該 story 舊有的 scripted / failed 子任務（重新分析時覆蓋，done 的留著）
      const oldSnap = await db.collection(COL.tasks)
        .where('parentTaskId', '==', taskId)
        .where('status', 'in', ['scripted', 'failed'])
        .get();
      const batch = db.batch();
      oldSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();

      // 建新的 scripted 任務
      for (const card of cards) {
        const imgRef = db.collection(COL.tasks).doc();
        await imgRef.set({
          userId: task.userId,
          characterId: task.characterId,
          type: 'image_generation',
          intent: card.title,
          params: {},
          status: 'scripted',
          parentTaskId: taskId,
          order: card.order,
          cardText: card.cardText,
          cardType: card.cardType,
          notified: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      await ref.update({ status: 'ready', updatedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ref.update({ status: 'failed', error: msg }).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true, queued: true });
}

async function analyzeStory(story: string, imageStyle: string): Promise<CardSlot[]> {
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY ?? '', { bridgeTimeoutMs: 160_000 });
  const styleHint = imageStyle ? `角色圖片風格偏好：${imageStyle}。` : '';

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: (
      '你是一個視覺故事板規劃師。分析故事文字，決定需要幾張圖片（4到10張）才能完整說完這個故事，'
      + '並為每張圖片寫說明文字，同時決定最適合的呈現方式（寫實照片或資訊圖表）。\n'
      + '輸出格式：在 <result> 標籤內放 JSON 陣列。只輸出 <result> 標籤，不要其他說明。'
    ),
    messages: [{
      role: 'user',
      content: (
        `故事內容：\n${story}\n\n${styleHint}\n\n`
        + `請分析故事，為每張圖卡決定：\n`
        + `- order：順序（從1開始）\n`
        + `- title：圖卡標題（中文，5-15字）\n`
        + `- cardText：說明文字（中文，2-4句，描述這張圖要呈現的畫面或資訊）\n`
        + `- cardType："realistic_photo"（適合呈現場景、人物、情節）或 "infographic"（適合呈現數據、流程、比較、概念）\n\n`
        + `<result>[{"order":1,"title":"...","cardText":"...","cardType":"realistic_photo"}]</result>`
      ),
    }],
  });

  const text = resp.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
  const match = text.match(/<result>([\s\S]*?)<\/result>/);
  if (!match) throw new Error('LLM did not return <result> block');

  const parsed = JSON.parse(match[1].trim()) as unknown[];
  return parsed
    .filter((s): s is CardSlot =>
      typeof s === 'object' && s !== null &&
      typeof (s as Record<string, unknown>).order === 'number' &&
      typeof (s as Record<string, unknown>).cardText === 'string' &&
      ['realistic_photo', 'infographic'].includes((s as Record<string, unknown>).cardType as string)
    )
    .sort((a, b) => a.order - b.order);
}
