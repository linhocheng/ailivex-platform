/**
 * POST /api/convert/podcast/sharpen-goal — 磨題
 *
 * 題目不會收斂，目標才會：「聊說服」是題目；「一個簡報做得很好、邏輯清晰的人，
 * 為什麼說服不了人？」才是目標。這裡把用戶隨手打的主題磨成一集必須回答的問題，
 * 回給前端可編輯欄位——目標由人持有，人只把這一次關（Adam 拍板 2026-07-11）。
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { topic?: string; characterNames?: string[] };
  const topic = (body.topic ?? '').trim();
  const names = (body.characterNames ?? []).filter(Boolean).slice(0, 2);

  try {
    const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY ?? '');
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: `把一個聊天題目磨成一集雙人對話「必須回答的問題」。題目不會收斂，目標才會：「聊說服」是題目；「一個簡報做得很好、邏輯清晰、數據紮實的人，為什麼說服不了人？」才是目標。好的目標有張力——兩個專業的人會在上面真的分開。${names.length === 2 ? `對話者：${names.join('、')}。` : ''}只輸出那一個問題，一句話，問號結尾，不加任何說明。`,
      messages: [{ role: 'user', content: `題目：${topic || '（未指定，從兩位對話者的專業交集出一題有張力的）'}` }],
    });
    const goal = (msg.content?.[0]?.type === 'text' ? msg.content[0].text : '')
      .trim().replace(/^["「『]|["」』]$/g, '');
    if (!goal) return NextResponse.json({ error: '磨題失敗，請重試' }, { status: 502 });
    return NextResponse.json({ goal });
  } catch (err) {
    console.error('[sharpen-goal]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: '磨題失敗，請重試' }, { status: 502 });
  }
}
