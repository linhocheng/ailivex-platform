/**
 * POST /api/voice-source —— 即時語音「讀網址」的薄抓取端點。
 *
 * 角色（Cloud Run agent）背後的工作臺呼這支抓網址正文，複用 url-reader 的 SSRF 防護，
 * 不在 Python 端重寫安全邏輯。靠 x-worker-secret 鑑權（server-to-server，無 session cookie），
 * 故須在 middleware PUBLIC_PATHS 放行。摘要 / embed / 存 source / 注入 context 都在 agent 端做。
 */
import { NextResponse } from 'next/server';
import { fetchUrlClean } from '@/lib/url-reader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = (process.env.WORKER_SECRET || '').trim();
  if (secret && req.headers.get('x-worker-secret') !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { url?: string } | null;
  const url = body?.url?.trim();
  if (!url) return NextResponse.json({ error: 'url 必填' }, { status: 400 });

  const r = await fetchUrlClean(url, 50000);
  // 抓取失敗不當 HTTP error：回 200 + ok:false，讓角色能坦白「打不開」而不是整通卡死。
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error });
  return NextResponse.json({ ok: true, title: r.title, text: r.text, finalUrl: r.finalUrl });
}
