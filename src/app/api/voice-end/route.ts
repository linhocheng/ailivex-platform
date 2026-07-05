import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { upsertRelationship } from '@/lib/relationship';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // userId 一律取自 session，不信 client 拼的 conversationId（audit：原寫法可替任意人灌關係計數）
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const body = await req.json().catch(() => null) as { characterId?: string } | null;
    const characterId = body?.characterId?.trim();
    if (characterId) {
      const db = getFirestore();
      await upsertRelationship(db, user.uid, characterId).catch((e: unknown) => console.error('[voice-end] upsertRelationship failed:', e));
    }
  } catch (e) { console.error('[voice-end] unexpected error:', e); }

  return NextResponse.json({ ok: true });
}
