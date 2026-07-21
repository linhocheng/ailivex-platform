import { NextResponse, type NextRequest } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/auth-session';

// 不需登入的路徑
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/doc-process', '/api/voice-source', '/api/tasks/callback', '/api/cron/memory-maintenance', '/api/cron/voice-auto-off', '/api/cron/memory-consolidation', '/api/cron/ops-rollup', '/api/cron/memory-health', '/api/agent/memory-blocks', '/api/agent/diary-write', '/api/agent/extract-memories', '/api/livekit/webhook'];

const isDev = process.env.NODE_ENV === 'development';

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

// CSP nonce 化（債 D6 清償，2026-07-21）：CSP 從 next.config 靜態 header 搬進這裡改 per-request nonce。
// 手術式——只收 script-src（nonce＋strict-dynamic＝真擋 inline XSS），不設 default-src
// （避免誤傷 LiveKit WebRTC/websocket、外部圖/音；語音平台的 connect 必須不受限）。
// style-src 留 unsafe-inline（React inline style 屬性無法帶 nonce）＋放行 fonts.googleapis.com
// （globals.css @import 外部 Google Fonts 樣式表；playwright 實測若不放行會被擋、中文掉 fallback 字型）。
// gstatic 字型檔不設 font-src（無 default-src 故不受限，載得到）。dev 補 unsafe-eval（React dev 用 eval）。
// Next 讀 request 的 Content-Security-Policy header 抓 nonce，蓋到自注入 hydration script。
// 搭配 root layout 的 force-dynamic：nonce 必須 dynamic render 才注入得到（靜態頁會死白頁）。
function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function buildCsp(nonce: string): string {
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');
}

export async function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const csp = buildCsp(nonce);
  const { pathname } = req.nextUrl;

  // 放行頁面：nonce 進 request header（Next 讀後蓋 script）＋回應掛 CSP
  const pass = () => {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };
  // 非頁面回應（redirect/401/403）：只掛 CSP header
  const attach = (res: NextResponse) => {
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };

  if (isPublic(pathname)) return pass();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  const isApi = pathname.startsWith('/api/');

  if (!session) {
    if (isApi) {
      return attach(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return attach(NextResponse.redirect(url));
  }

  // admin 區 + admin API 限管理者
  const adminOnly = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
  if (adminOnly && session.role !== 'admin') {
    if (isApi) {
      return attach(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    }
    const url = req.nextUrl.clone();
    url.pathname = '/lobby';
    return attach(NextResponse.redirect(url));
  }

  return pass();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)'],
};
