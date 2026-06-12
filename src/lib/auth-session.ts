/**
 * Session 簽章 — 用 Web Crypto（subtle.HMAC），Edge middleware 與 Node API route 都能跑。
 *
 * 為什麼不用 node:crypto？middleware 跑在 Edge runtime，沒有 node:crypto。
 * 密碼雜湊（scrypt）是 Node-only，放在 auth-password.ts，只由 login/seed route 引用。
 *
 * Token 格式：base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 * Stateless：cookie 自帶身份，不查 DB。要可撤銷時再加 sessions 表。
 */

export interface SessionPayload {
  uid: string;
  role: 'user' | 'admin';
  name: string;
  iat: number; // epoch seconds
}

const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 天

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

// 把 Uint8Array 複製進全新的 ArrayBuffer-backed buffer。
// 為什麼：TS lib 把 subtle.sign/verify 的 BufferSource 收窄成 ArrayBuffer-backed，
// enc.encode() 回傳的 Uint8Array<ArrayBufferLike> 可能是 SharedArrayBuffer，型別會被拒。
function ab(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET not set');
  return s;
}

export async function signSession(
  payload: Omit<SessionPayload, 'iat'>,
): Promise<string> {
  const full: SessionPayload = { ...payload, iat: Math.floor(Date.now() / 1000) };
  const body = b64urlEncode(enc.encode(JSON.stringify(full)));
  const key = await getKey(getSecret());
  const sig = await crypto.subtle.sign('HMAC', key, ab(enc.encode(body)));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  try {
    const key = await getKey(getSecret());
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      ab(b64urlDecode(sigPart)),
      ab(enc.encode(body)),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (!payload.iat || Date.now() / 1000 - payload.iat > SESSION_TTL_SEC) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'ailivex_session';
export const SESSION_MAX_AGE = SESSION_TTL_SEC;
