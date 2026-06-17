/**
 * 連結閱讀 —— 文字對話用。用戶訊息裡有 URL → 伺服器抓網頁 → 抽正文 → 餵進角色 context。
 *
 * 天條：偵測/抓取/抽正文/截斷全是確定性程式，只有「討論」丟 LLM。
 * 安全：SSRF 是這支的核心風險 —— DNS 解析後檢查 IP 不是私有/保留段，redirect 逐跳重驗，
 *      擋掉「用戶貼內網/雲端 metadata IP 把伺服器當跳板」。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_URLS = 2;            // 一則訊息最多讀幾條連結
const MAX_CHARS = 3500;        // 每條正文截斷
const FETCH_TIMEOUT_MS = 7000; // 單條抓取逾時（別拖垮 120s 對話）
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const URL_RE = /https?:\/\/[^\s<>"'（）()【】]+/gi;

export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) || [];
  const cleaned = found.map(u => u.replace(/[.,;:!?。，、；：！？]+$/, ''));
  return [...new Set(cleaned)].slice(0, MAX_URLS);
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;            // link-local + 雲端 metadata 169.254.169.254
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // ipv4-mapped
    if (v.startsWith('fc') || v.startsWith('fd')) return true;   // unique local
    if (v.startsWith('fe80')) return true;                       // link-local
    return false;
  }
  return true; // 認不出 → 當不安全
}

async function assertSafeUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允許 http/https');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('內網主機');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('指向私有/內網 IP');
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error('DNS 解析失敗');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('解析到私有/內網 IP');
  }
}

async function fetchGuarded(rawUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return null; }
    await assertSafeUrl(u);   // 每一跳（含 redirect 目標）都重驗，防 redirect 繞過

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'ailiveX-link-reader/1.0',
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) return null;

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) return null;
    const len = Number(res.headers.get('content-length') || '0');
    if (len && len > MAX_BYTES) return null;

    const html = await res.text();
    return { html: html.slice(0, MAX_BYTES), finalUrl: u.toString() };
  }
  return null; // redirect 太多
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, ' '); }

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}

function htmlToText(html: string): { title: string; text: string } {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(stripTags(titleM[1])).replace(/\s+/g, ' ').trim() : '';
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|article|section)>/gi, '\n');
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}

/**
 * 抓單一指定 URL 的乾淨正文（即時語音「讀網址」用，SSRF 防護沿用 fetchGuarded）。
 * 與 readUrlsForContext 的差別：不從文字抽 URL、給更大的字數上限（供摘要），結構化回傳成敗。
 */
export async function fetchUrlClean(
  rawUrl: string,
  maxChars = 8000,
): Promise<{ ok: true; title: string; text: string; finalUrl: string } | { ok: false; error: string }> {
  let u: URL;
  try { u = new URL(rawUrl.trim()); } catch { return { ok: false, error: '網址格式無效' }; }
  try {
    const r = await fetchGuarded(u.toString());
    if (!r) return { ok: false, error: '讀不到或不是網頁' };
    const { title, text } = htmlToText(r.html);
    if (!text) return { ok: false, error: '抓到頁面但沒有可讀正文' };
    return { ok: true, title, text: text.slice(0, maxChars), finalUrl: r.finalUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '無法讀取' };
  }
}

/**
 * 偵測 message 裡的 URL，抓取並抽正文，回傳要附到角色 context 的區塊。
 * 沒有 URL → 回空字串。抓不到 → 回「讀取失敗」讓角色能坦白說打不開。
 */
export async function readUrlsForContext(text: string): Promise<string> {
  const urls = extractUrls(text);
  if (!urls.length) return '';

  const blocks: string[] = [];
  for (const url of urls) {
    try {
      const r = await fetchGuarded(url);
      if (!r) {
        blocks.push(`【連結讀取失敗】${url}（讀不到或不是網頁，可以告訴對方你打不開）`);
        continue;
      }
      const { title, text: body } = htmlToText(r.html);
      if (!body) {
        blocks.push(`【連結讀取失敗】${url}（抓到頁面但沒有可讀正文，告訴對方你看不出內容）`);
        continue;
      }
      const clipped = body.slice(0, MAX_CHARS);
      const more = body.length > MAX_CHARS ? '…（內容過長，只擷取開頭）' : '';
      blocks.push(`【用戶分享的連結內容】${url}${title ? `\n標題：${title}` : ''}\n${clipped}${more}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : '無法讀取';
      blocks.push(`【連結讀取失敗】${url}（${reason}，可以告訴對方你打不開）`);
    }
  }
  return '\n\n' + blocks.join('\n\n');
}
