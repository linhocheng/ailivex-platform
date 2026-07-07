/**
 * POST /api/text-filter/rewrite
 * 一鍵改寫踩雷句：只改含踩雷片語的句子，其他字不動。
 * 帶 characterId 則用該角色 soul 保語氣。編輯按了才跑（標記模式配套，不自動）。
 * Body: { text: string; characterId?: string }
 * Returns: { text: string; before: number; after: number }
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';
import { COL } from '@/lib/collections';
import { loadPatterns, scanText, rewriteFlagged } from '@/lib/text-filter';

export const runtime = 'nodejs';
export const maxDuration = 90;

const BRIDGE_ENDPOINT = `${cleanUrl((process.env.BRIDGE_URL ?? '').replace(/\/v1\/messages\/?$/, ''))}/v1/messages`;
const BRIDGE_SECRET = cleanSecret(process.env.BRIDGE_SECRET);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const { text, characterId } = await req.json() as { text?: string; characterId?: string };
    if (!text?.trim()) return NextResponse.json({ error: 'text 必填' }, { status: 400 });

    const db = getFirestore();
    const patterns = await loadPatterns(db);
    const hits = scanText(text, patterns);
    if (hits.length === 0) return NextResponse.json({ text, before: 0, after: 0 });

    let soul: string | undefined;
    if (characterId) {
      const snap = await db.collection(COL.characters).doc(characterId).get();
      const c = snap.data() as { soul?: string } | undefined;
      soul = c?.soul;
    }

    const rewritten = await rewriteFlagged(text, hits, BRIDGE_ENDPOINT, BRIDGE_SECRET, soul);
    const residual = scanText(rewritten, patterns);
    return NextResponse.json({ text: rewritten, before: hits.length, after: residual.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
