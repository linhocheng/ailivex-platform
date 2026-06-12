import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { COL, type CharacterDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();

  if (user.role !== 'admin' && !(await hasAccess(db, user.uid, id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const snap = await db.collection(COL.characters).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  const c = snap.data() as CharacterDoc;
  return NextResponse.json({
    id,
    name: c.name || '',
    avatarUrl: c.avatarUrl || '',
    hasVoice: !!(c.voiceIdMinimax),
  });
}
