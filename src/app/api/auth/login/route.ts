import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type UserDoc } from '@/lib/collections';
import { verifyPassword } from '@/lib/auth-password';
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth-session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { username?: string; password?: string } | null;
  const username = body?.username?.trim();
  const password = body?.password ?? '';
  if (!username || !password) {
    return NextResponse.json({ error: '請輸入帳號密碼' }, { status: 400 });
  }

  const db = getFirestore();
  const snap = await db.collection(COL.users)
    .where('username', '==', username)
    .limit(1)
    .get();

  if (snap.empty) {
    return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
  }

  const doc = snap.docs[0];
  const user = doc.data() as UserDoc;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
  }

  const token = await signSession({ uid: doc.id, role: user.role, name: user.displayName });
  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
