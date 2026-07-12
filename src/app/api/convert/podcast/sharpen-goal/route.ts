/**
 * POST /api/convert/podcast/sharpen-goal — 磨題＋聽眾鏡像
 *
 * 題目不會收斂，目標才會：「聊說服」是題目；「一個簡報做得很好、邏輯清晰的人，
 * 為什麼說服不了人？」才是目標。這裡把用戶隨手打的主題磨成一集必須回答的問題，
 * 同時想像今晚最需要這一集的那個聽眾（persona＋他帶進來的誤解）——對話為一個
 * 具體的人存在，不是為協議存在。三個欄位都回給前端可編輯——由人持有
 * （Adam 拍板 2026-07-11；聽眾鏡像 2026-07-12 關係矩陣版）。
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

export const runtime = 'nodejs';
export const maxDuration = 120; // bridge 冷啟 ~34s＋三欄位生成，60s 偶爾不夠

/** 確定性 JSON 抽取（bridge 無 tool_use；LLM 輸出當不可信文字，程式 parse） */
function extractJson<T>(raw: string): T | null {
  const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}

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
      max_tokens: 400,
      system: `把一個聊天題目磨成一集雙人對話的三件東西：
1. goal — 這一集「必須回答的問題」。題目不會收斂，目標才會：「聊說服」是題目；「一個簡報做得很好、邏輯清晰、數據紮實的人，為什麼說服不了人？」才是目標。好的目標有張力——兩個專業的人會在上面真的分開。一句話，問號結尾。
2. audiencePersona — 今晚最需要這一集的那個聽眾。不是「大眾」，是一個具體的人，帶處境（例：常被客戶拒絕、內向的年輕業務）。一句話。
3. audienceMisconception — 他帶著什麼誤解走進來（例：以為說服別人一定要口若懸河）。一句話。
${names.length === 2 ? `對話者：${names.join('、')}。` : ''}只輸出純JSON，不加任何說明：{"goal":"...？","audiencePersona":"...","audienceMisconception":"..."}`,
      messages: [{ role: 'user', content: `題目：${topic || '（未指定，從兩位對話者的專業交集出一題有張力的）'}` }],
    });
    const raw = msg.content?.[0]?.type === 'text' ? msg.content[0].text : '';
    const p = extractJson<{ goal?: string; audiencePersona?: string; audienceMisconception?: string }>(raw);
    const goal = (p?.goal ?? '').trim().replace(/^["「『]|["」』]$/g, '');
    if (!goal) return NextResponse.json({ error: '磨題失敗，請重試' }, { status: 502 });
    return NextResponse.json({
      goal,
      audiencePersona: (p?.audiencePersona ?? '').trim(),
      audienceMisconception: (p?.audienceMisconception ?? '').trim(),
    });
  } catch (err) {
    console.error('[sharpen-goal]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: '磨題失敗，請重試' }, { status: 502 });
  }
}
