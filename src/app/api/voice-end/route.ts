import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { upsertRelationship } from '@/lib/relationship';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { characterId?: string; conversationId?: string } | null;
    const characterId = body?.characterId?.trim();
    const conversationId = body?.conversationId || '';

    if (characterId && conversationId) {
      // conversationId 格式：ailivex-voice-{characterId}-{userId}
      const parts = conversationId.split('-');
      const userId = parts.slice(3).join('-');
      if (userId) {
        const db = getFirestore();
        await upsertRelationship(db, userId, characterId).catch(() => {});
      }
    }
  } catch { /* voice-end 失敗不影響通話收尾 */ }

  return NextResponse.json({ ok: true });
}
