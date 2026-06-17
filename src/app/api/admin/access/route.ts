import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, VOICE_VERSIONS, type AccessDoc } from '@/lib/collections';

export const runtime = 'nodejs';

function accessId(userId: string, characterId: string) {
  return `${userId}_${characterId}`;
}

const VALID_VERSIONS = new Set<string>(VOICE_VERSIONS.map(v => v.id));

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
    return { id: d.id, userId: a.userId, characterId: a.characterId, voiceVersion: a.voiceVersion || '' };
  });
  return NextResponse.json({ access });
}

// 變更指派的語音版本（用戶端看不到，後台說了算）
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null) as { userId?: string; characterId?: string; voiceVersion?: string } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  const voiceVersion = body?.voiceVersion?.trim() || '';
  if (!userId || !characterId) {
    return NextResponse.json({ error: 'userId 與 characterId 必填' }, { status: 400 });
  }
  if (voiceVersion && !VALID_VERSIONS.has(voiceVersion)) {
    return NextResponse.json({ error: '未知的語音版本' }, { status: 400 });
  }
  const db = getFirestore();
  const ref = db.collection(COL.access).doc(accessId(userId, characterId));
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '尚未開通，無法設定版本' }, { status: 404 });
  // 空字串 = 回到全域預設（清掉欄位）
  await ref.set({ voiceVersion: voiceVersion || FieldValue.delete() }, { merge: true });
  return NextResponse.json({ ok: true, voiceVersion });
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
