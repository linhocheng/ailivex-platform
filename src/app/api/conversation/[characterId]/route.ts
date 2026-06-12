import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { loadHistory } from '@/lib/conversation';
import { COL, type CharacterDoc } from '@/lib/collections';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ characterId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { characterId } = await ctx.params;
  const db = getFirestore();
  if (user.role !== 'admin' && !(await hasAccess(db, user.uid, characterId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const c = charSnap.data() as CharacterDoc;

  const messages = await loadHistory(db, user.uid, characterId);
  return NextResponse.json({
    character: { id: characterId, name: c.name, avatarUrl: c.avatarUrl, hasVoice: !!c.voiceIdMinimax },
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });
}
