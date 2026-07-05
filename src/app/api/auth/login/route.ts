import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type UserDoc } from '@/lib/collections';
import { verifyPassword } from '@/lib/auth-password';
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth-session';

export const runtime = 'nodejs';

// 暴力破解防護：Firestore 滑動視窗（serverless 記憶體不跨 instance，用 DB 共享；計數是程式不是模型）
const RL_MAX_FAILS = 8;
const RL_WINDOW_MS = 15 * 60_000;

function attemptRef(db: FirebaseFirestore.Firestore, username: string) {
  return db.collection('login_attempts').doc(encodeURIComponent(username).slice(0, 500));
}

async function isLocked(db: FirebaseFirestore.Firestore, username: string): Promise<boolean> {
  const snap = await attemptRef(db, username).get();
  if (!snap.exists) return false;
  const d = snap.data() as { fails?: number; firstFailAt?: number };
  if (Date.now() - Number(d.firstFailAt || 0) > RL_WINDOW_MS) return false; // 視窗過期
  return Number(d.fails || 0) >= RL_MAX_FAILS;
}

async function recordFail(db: FirebaseFirestore.Firestore, username: string): Promise<void> {
  const ref = attemptRef(db, username);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const d = (snap.data() ?? {}) as { fails?: number; firstFailAt?: number };
    if (!snap.exists || Date.now() - Number(d.firstFailAt || 0) > RL_WINDOW_MS) {
      tx.set(ref, { fails: 1, firstFailAt: Date.now() });
    } else {
      tx.update(ref, { fails: Number(d.fails || 0) + 1 });
    }
  }).catch(() => { /* 防護寫入失敗不擋登入主流程 */ });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { username?: string; password?: string } | null;
  const username = body?.username?.trim();
  const password = body?.password ?? '';
  if (!username || !password) {
    return NextResponse.json({ error: '請輸入帳號密碼' }, { status: 400 });
  }

  const db = getFirestore();

  if (await isLocked(db, username)) {
    return NextResponse.json({ error: '嘗試次數過多，請 15 分鐘後再試' }, { status: 429 });
  }

  const snap = await db.collection(COL.users)
    .where('username', '==', username)
    .limit(1)
    .get();

  if (snap.empty) {
    await recordFail(db, username);
    return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
  }

  const doc = snap.docs[0];
  const user = doc.data() as UserDoc;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordFail(db, username);
    return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
  }

  await attemptRef(db, username).delete().catch(() => {}); // 成功登入清計數

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
