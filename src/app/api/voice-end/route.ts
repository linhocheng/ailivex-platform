import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { upsertRelationship } from '@/lib/relationship';
import { closeVoiceSession, recordOpsEvent } from '@/lib/ops-event';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // userId 一律取自 session，不信 client 拼的 conversationId（audit：原寫法可替任意人灌關係計數）
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const body = await req.json().catch(() => null) as { characterId?: string; roomName?: string } | null;
    const characterId = body?.characterId?.trim();
    if (characterId) {
      const db = getFirestore();
      await Promise.all([
        upsertRelationship(db, user.uid, characterId).catch((e: unknown) => {
          console.error('[voice-end] upsertRelationship failed:', e);
          // 吞可以，吞之前留痕（監控 Phase 2）
          recordOpsEvent({ kind: 'side_effect_error', status: 'fail', sideEffect: 'relationship', userId: user.uid, characterId, error: e instanceof Error ? e.message : String(e) });
        }),
        // 監控 session 收盤（roomName 缺失時 fallback 找最新 open）
        closeVoiceSession(user.uid, characterId, body?.roomName?.trim() || undefined),
      ]);
    }
  } catch (e) { console.error('[voice-end] unexpected error:', e); }

  return NextResponse.json({ ok: true });
}
