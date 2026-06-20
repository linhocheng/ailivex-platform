/**
 * POST /api/tasks/[id]/generate-story  (Phase A)
 *
 * 以故事主題／簡介為輸入，呼叫 LLM 生成完整故事文字。
 * 完成後更新 storyText、status → 'scripting'，並 fire-and-forget 觸發 Phase B。
 *
 * 雙軌 auth：
 *   - Python agent dispatch 後呼叫：x-worker-secret header
 *   - 用戶在故事板頁面手動「重新生成」：session cookie
 */
import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type CharacterDoc } from '@/lib/collections';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 180;

function platformUrl() {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return cleanUrl(base);
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

  // 取角色靈魂
  let charName = ''; let charSoul = '';
  if (task.characterId) {
    const cs = await db.collection(COL.characters).doc(task.characterId as string).get();
    if (cs.exists) {
      const c = cs.data() as CharacterDoc;
      charName = c.name;
      charSoul = c.soulCore || c.soul || '';
    }
  }

  await ref.update({ status: 'pending' });

  // 快速回 200，LLM 工作在 after() 裡執行（after() 可使用 route 的 maxDuration 時限）
  after(async () => {
    try {
      const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY ?? '', { bridgeTimeoutMs: 160_000 });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: charSoul
          ? `你是「${charName}」。${charSoul}\n\n請用你的身份和風格寫故事。`
          : '你是一個創意故事寫手，擅長寫生動有畫面感的故事。',
        messages: [{
          role: 'user',
          content: (
            `請根據以下主題，寫一篇完整的故事（約 500-800 字）。\n`
            + `主題：${task.intent || (task.params as Record<string, unknown>)?.brief || '一個精彩的故事'}\n\n`
            + `要求：\n`
            + `- 分成 5-8 個段落，每段有清楚的場景或情節推進\n`
            + `- 有畫面感，適合後續生成圖片\n`
            + `- 直接寫故事本文，不要標題、不要前言說明`
          ),
        }],
      });

      const storyText = resp.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim();

      await ref.update({ storyText, status: 'scripting', updatedAt: FieldValue.serverTimestamp() });

      // 觸發 Phase B：await fetch 讓連線確實送出（generate-scripts 也是快速回 200）
      const base = platformUrl();
      const secret = cleanSecret(process.env.WORKER_SECRET);
      if (base && secret) {
        await fetch(`${base}/api/tasks/${taskId}/generate-scripts`, {
          method: 'POST',
          headers: { 'x-worker-secret': secret, 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(err => console.error('[generate-story] Phase B trigger failed:', err instanceof Error ? err.message : String(err)));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ref.update({ status: 'failed', error: msg }).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true, queued: true });
}
