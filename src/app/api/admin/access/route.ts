import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type AccessDoc } from '@/lib/collections';

export const runtime = 'nodejs';

function accessId(userId: string, characterId: string) {
  return `${userId}_${characterId}`;
}

// 列出指派關係（可選 ?userId= 過濾）
export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const db = getFirestore();
  let q: FirebaseFirestore.Query = db.collection(COL.access);
  if (userId) q = q.where('userId', '==', userId);
  const snap = await q.get();
  const access = snap.docs.map(d => {
    const a = d.data() as AccessDoc;
    return { id: d.id, userId: a.userId, characterId: a.characterId };
  });
  return NextResponse.json({ access });
}

// 指派：開通某用戶能跟某角色聊
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { userId?: string; characterId?: string } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  if (!userId || !characterId) {
    return NextResponse.json({ error: 'userId 與 characterId 必填' }, { status: 400 });
  }
  const db = getFirestore();
  const doc: AccessDoc = { userId, characterId, grantedAt: new Date() };
  await db.collection(COL.access).doc(accessId(userId, characterId)).set(doc);
  return NextResponse.json({ ok: true, id: accessId(userId, characterId) });
}

// 撤銷指派
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => null) as { userId?: string; characterId?: string } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  if (!userId || !characterId) {
    return NextResponse.json({ error: 'userId 與 characterId 必填' }, { status: 400 });
  }
  const db = getFirestore();
  await db.collection(COL.access).doc(accessId(userId, characterId)).delete();
  return NextResponse.json({ ok: true });
}
