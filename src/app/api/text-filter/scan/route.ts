/**
 * POST /api/text-filter/scan
 * 掃描文字的踩雷片語（AI 味／農場詞），回報位置供 UI 標記。純程式掃描，不動文字。
 * Body: { text: string }
 * Returns: { hits: FilterHit[] }
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { loadPatterns, scanText } from '@/lib/text-filter';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const { text } = await req.json() as { text?: string };
    if (!text?.trim()) return NextResponse.json({ hits: [] });
    const patterns = await loadPatterns(getFirestore());
    return NextResponse.json({ hits: scanText(text, patterns) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
