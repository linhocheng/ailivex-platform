import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type UserDoc, type UserRole } from '@/lib/collections';
import { hashPassword } from '@/lib/auth-password';

export const runtime = 'nodejs';

// 列出所有用戶（不含密碼）
export async function GET() {
  const db = getFirestore();
  const snap = await db.collection(COL.users).orderBy('createdAt', 'desc').get();
  const users = snap.docs.map(d => {
    const u = d.data() as UserDoc;
    return { id: d.id, username: u.username, displayName: u.displayName, role: u.role };
  });
  return NextResponse.json({ users });
}

// 管理者開帳號
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as {
    username?: string; displayName?: string; password?: string; role?: UserRole;
  } | null;

  const username = body?.username?.trim();
  const displayName = body?.displayName?.trim() || username;
  const password = body?.password ?? '';
  const role: UserRole = body?.role === 'admin' ? 'admin' : 'user';

  if (!username || !password) {
    return NextResponse.json({ error: '帳號與密碼必填' }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: '密碼至少 6 碼' }, { status: 400 });
  }

  const db = getFirestore();
  const dup = await db.collection(COL.users).where('username', '==', username).limit(1).get();
  if (!dup.empty) {
    return NextResponse.json({ error: '帳號已存在' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const doc: UserDoc = {
    username,
    displayName: displayName!,
    passwordHash,
    role,
    createdAt: new Date(),
  };
  const ref = await db.collection(COL.users).add(doc);
  return NextResponse.json({ id: ref.id, username, displayName, role });
}
