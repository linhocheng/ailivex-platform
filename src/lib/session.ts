/**
 * Route handler / server component 端取得當前登入者。
 * middleware 已擋掉未登入，這裡是拿身份用（uid / role / name）。
 */
import { cookies } from 'next/headers';
import { verifySession, type SessionPayload, SESSION_COOKIE } from '@/lib/auth-session';

export async function getCurrentUser(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(token);
}
