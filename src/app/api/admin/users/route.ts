import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type UserDoc, type UserRole } from '@/lib/collections';
import { hashPassword } from '@/lib/auth-password';

export const runtime = 'nodejs';

// 列出所有用戶（不含密碼；含用量管制欄位）
export async function GET() {
  const db = getFirestore();
  const snap = await db.collection(COL.users).orderBy('createdAt', 'desc').get();
  const users = snap.docs.map(d => {
    const u = d.data() as UserDoc;
    return {
      id: d.id, username: u.username, displayName: u.displayName, role: u.role,
      voiceSecondsLimit: typeof u.voiceSecondsLimit === 'number' ? u.voiceSecondsLimit : null,
      voiceSecondsUsed: Number(u.voiceSecondsUsed || 0),
      docsLimit: typeof u.docsLimit === 'number' ? u.docsLimit : null,
      docsUsed: Number(u.docsUsed || 0),
      mediaLimit: typeof u.mediaLimit === 'number' ? u.mediaLimit : null,
      mediaUsed: Number(u.mediaUsed || 0),
      textLimit: typeof u.textLimit === 'number' ? u.textLimit : null,
      textUsed: Number(u.textUsed || 0),
    };
  });
  return NextResponse.json({ users });
}

// 設定用量管制（總量制）＋密碼重設：
//   { userId, voiceSecondsLimit?: number|null, docsLimit?: number|null,
//     resetVoiceUsed?: boolean, resetDocsUsed?: boolean, newPassword?: string }
//   limit 傳 null = 清除欄位（回到不限）；used 只能歸零不能改值
//   newPassword：直接重設立即生效（session cookie 無狀態，舊登入到期前仍有效）
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null) as {
    userId?: string;
    voiceSecondsLimit?: number | null;
    docsLimit?: number | null;
    mediaLimit?: number | null;
    textLimit?: number | null;
    resetVoiceUsed?: boolean;
    resetDocsUsed?: boolean;
    resetMediaUsed?: boolean;
    resetTextUsed?: boolean;
    newPassword?: string;
  } | null;
  const userId = body?.userId?.trim();
  if (!userId) return NextResponse.json({ error: 'userId 必填' }, { status: 400 });

  const db = getFirestore();
  const ref = db.collection(COL.users).doc(userId);
  if (!(await ref.get()).exists) return NextResponse.json({ error: '用戶不存在' }, { status: 404 });

  const updates: Record<string, unknown> = {};
  if (body?.newPassword !== undefined) {
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 6) {
      return NextResponse.json({ error: '密碼至少 6 碼' }, { status: 400 });
    }
    updates.passwordHash = await hashPassword(body.newPassword);
  }
  if ('voiceSecondsLimit' in (body ?? {})) {
    if (body!.voiceSecondsLimit === null) updates.voiceSecondsLimit = FieldValue.delete();
    else if (typeof body!.voiceSecondsLimit === 'number' && body!.voiceSecondsLimit >= 0) {
      updates.voiceSecondsLimit = Math.round(body!.voiceSecondsLimit);
    } else return NextResponse.json({ error: 'voiceSecondsLimit 需為 >= 0 的數字或 null' }, { status: 400 });
  }
  if ('docsLimit' in (body ?? {})) {
    if (body!.docsLimit === null) updates.docsLimit = FieldValue.delete();
    else if (typeof body!.docsLimit === 'number' && body!.docsLimit >= 0) {
      updates.docsLimit = Math.round(body!.docsLimit);
    } else return NextResponse.json({ error: 'docsLimit 需為 >= 0 的數字或 null' }, { status: 400 });
  }
  if ('mediaLimit' in (body ?? {})) {
    if (body!.mediaLimit === null) updates.mediaLimit = FieldValue.delete();
    else if (typeof body!.mediaLimit === 'number' && body!.mediaLimit >= 0) {
      updates.mediaLimit = Math.round(body!.mediaLimit);
    } else return NextResponse.json({ error: 'mediaLimit 需為 >= 0 的數字或 null' }, { status: 400 });
  }
  if ('textLimit' in (body ?? {})) {
    if (body!.textLimit === null) updates.textLimit = FieldValue.delete();
    else if (typeof body!.textLimit === 'number' && body!.textLimit >= 0) {
      updates.textLimit = Math.round(body!.textLimit);
    } else return NextResponse.json({ error: 'textLimit 需為 >= 0 的數字或 null' }, { status: 400 });
  }
  if (body?.resetVoiceUsed) updates.voiceSecondsUsed = 0;
  if (body?.resetDocsUsed) updates.docsUsed = 0;
  if (body?.resetMediaUsed) updates.mediaUsed = 0;
  if (body?.resetTextUsed) updates.textUsed = 0;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: '沒有要更新的欄位' }, { status: 400 });
  }
  await ref.update(updates);
  return NextResponse.json({ ok: true });
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

// 刪除用戶：user doc + 該用戶所有指派（access）級聯清除。
// 對話/記憶/文件保留（歷史資料，含角色記憶脈絡；用戶已無法登入，不外洩）。
// admin 帳號不可刪（防鎖死後台）。
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => null) as { userId?: string } | null;
  const userId = body?.userId?.trim();
  if (!userId) return NextResponse.json({ error: 'userId 必填' }, { status: 400 });

  const db = getFirestore();
  const ref = db.collection(COL.users).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '用戶不存在' }, { status: 404 });
  if ((snap.data() as UserDoc).role === 'admin') {
    return NextResponse.json({ error: 'admin 帳號不可刪除' }, { status: 400 });
  }

  const accessSnap = await db.collection(COL.access).where('userId', '==', userId).get();
  const batch = db.batch();
  accessSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();

  return NextResponse.json({ ok: true, deletedAccess: accessSnap.size });
}
