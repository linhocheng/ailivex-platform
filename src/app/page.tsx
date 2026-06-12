import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE } from '@/lib/auth-session';

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session) redirect('/login');
  if (session.role === 'admin') redirect('/admin');
  redirect('/lobby');
}
