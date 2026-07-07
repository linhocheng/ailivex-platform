import { NextResponse, type NextRequest } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/auth-session';

// 不需登入的路徑
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/doc-process', '/api/voice-source', '/api/tasks/callback', '/api/cron/memory-maintenance', '/api/cron/voice-auto-off', '/api/cron/memory-consolidation'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  const isApi = pathname.startsWith('/api/');

  if (!session) {
    if (isApi) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // admin 區 + admin API 限管理者
  const adminOnly = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
  if (adminOnly && session.role !== 'admin') {
    if (isApi) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/lobby';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)'],
};
