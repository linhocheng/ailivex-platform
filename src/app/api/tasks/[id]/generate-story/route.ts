/**
 * POST /api/tasks/[id]/generate-story  (Phase A + B 合一)
 *
 * 快速回 200，在 after() 裡依序執行：
 *   A. LLM 生成故事文字（status: pending → scripting）
 *   B. LLM 分析圖卡腳本，建立 N 個 image_generation tasks（status: → ready）
 *
 * A→B 在同一個 after() 內完成，不靠 HTTP 鏈。
 * generate-scripts 仍保留作為手動「重新分析」的獨立端點。
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

interface CardSlot {
  order: number;
  title: string;
  cardText: string;
  cardType: 'realistic_photo' | 'infographic';
}

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

  // 取角色靈魂 + 圖片風格
  let charName = ''; let charSoul = ''; let imageStyle = '';
  if (task.characterId) {
    const cs = await db.collection(COL.characters).doc(task.characterId as string).get();
    if (cs.exists) {
      const c = cs.data() as CharacterDoc;
      charName = c.name;
      charSoul = c.soulCore || c.soul || '';
      imageStyle = c.imageStyle ?? '';
    }
  }

  await ref.update({ status: 'pending' });

  // 快速回 200；A+B 在同一個 after() 內跑，不靠 HTTP 鏈
  after(async () => {
    const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY ?? '', { bridgeTimeoutMs: 150_000 });
    const taskParams = (task.params as Record<string, unknown>) ?? {};
    const cardCount = typeof taskParams.cardCount === 'number' && taskParams.cardCount >= 1 ? taskParams.cardCount : 0;
    const storyLength = (taskParams.storyLength as string) || 'medium';
    const storySpec = storyLength === 'short'
      ? { words: '200-350 字', paragraphs: '3-4 個段落' }
      : storyLength === 'long'
        ? { words: '800-1200 字', paragraphs: '8-12 個段落' }
        : { words: '500-800 字', paragraphs: '5-8 個段落' };

    // ── Phase A：生成故事 ──────────────────────────────────────
    let storyText = '';
    try {
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: charSoul
          ? `你是「${charName}」。${charSoul}\n\n請用你的身份和風格寫故事。`
          : '你是一個創意故事寫手，擅長寫生動有畫面感的故事。',
        messages: [{
          role: 'user',
          content: (
            `請根據以下主題，寫一篇完整的故事（約 ${storySpec.words}）。\n`
            + `主題：${task.intent || taskParams?.brief || '一個精彩的故事'}\n\n`
            + `要求：\n`
            + `- 分成 ${storySpec.paragraphs}，每段有清楚的場景或情節推進\n`
            + `- 有畫面感，適合後續生成圖片\n`
            + `- 直接寫故事本文，不要標題、不要前言說明`
          ),
        }],
      });
      storyText = resp.content.filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text).join('').trim();
      await ref.update({ storyText, status: 'scripting', updatedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      await ref.update({ status: 'failed', error: err instanceof Error ? err.message : String(err) }).catch(() => {});
      return;
    }

    // ── Phase B：分析圖卡腳本 ─────────────────────────────────
    try {
      const styleHint = imageStyle ? `角色圖片風格偏好：${imageStyle}。` : '';
      const cardCountInstruction = cardCount >= 1
        ? `必須產出剛好 ${cardCount} 張圖卡（用戶指定）。`
        : '決定需要幾張圖片（4到10張）才能完整說完這個故事。';
      const bResp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: (
          `你是一個視覺故事板規劃師。分析故事文字，${cardCountInstruction}`
          + '並為每張圖片寫說明文字，同時決定最適合的呈現方式（寫實照片或資訊圖表）。\n'
          + '輸出格式：在 <result> 標籤內放 JSON 陣列。只輸出 <result> 標籤，不要其他說明。'
        ),
        messages: [{
          role: 'user',
          content: (
            `故事內容：\n${storyText}\n\n${styleHint}\n\n`
            + `請分析故事，為每張圖卡決定：\n`
            + `- order：順序（從1開始）\n`
            + `- title：圖卡標題（中文，5-15字）\n`
            + `- cardText：說明文字（中文，2-4句，描述這張圖要呈現的畫面或資訊）\n`
            + `- cardType："realistic_photo"（適合呈現場景、人物、情節）或 "infographic"（適合呈現數據、流程、比較、概念）\n\n`
            + `<result>[{"order":1,"title":"...","cardText":"...","cardType":"realistic_photo"}]</result>`
          ),
        }],
      });

      const bText = bResp.content.filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text).join('');
      const match = bText.match(/<result>([\s\S]*?)<\/result>/);
      if (!match) throw new Error('Phase B: LLM 未回傳 <result> 區塊');

      const cards = (JSON.parse(match[1].trim()) as unknown[])
        .filter((s): s is CardSlot =>
          typeof s === 'object' && s !== null &&
          typeof (s as Record<string, unknown>).order === 'number' &&
          typeof (s as Record<string, unknown>).cardText === 'string' &&
          ['realistic_photo', 'infographic'].includes((s as Record<string, unknown>).cardType as string)
        )
        .sort((a, b) => a.order - b.order);

      if (!cards.length) throw new Error('Phase B: 解析出 0 張圖卡');

      // 刪除舊的 scripted / failed 子任務（重跑覆蓋，done 的留著）
      const oldSnap = await db.collection(COL.tasks)
        .where('parentTaskId', '==', taskId).where('status', 'in', ['scripted', 'failed']).get();
      const batch = db.batch();
      oldSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();

      // 建新的 scripted 任務
      for (const card of cards) {
        await db.collection(COL.tasks).doc().set({
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
      // Phase B 失敗：保留 scripting 狀態，讓用戶可以手動重新分析
      console.error('[generate-story] Phase B failed:', err instanceof Error ? err.message : String(err));
      await ref.update({ status: 'scripting', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true, queued: true });
}
