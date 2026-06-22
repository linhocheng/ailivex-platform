/**
 * /api/doc-process — 文件非同步生成 worker（Vercel 內部）
 *
 * 取代 Cloud Tasks → Cloud Run 鏈路：dialogue route fire-and-forget 打這裡即可。
 * 走 bridge 吃到飽 key，不燒付費 ANTHROPIC_API_KEY。
 * maxDuration = 300 足以應付 bridge 生成。
 */
import { NextResponse } from 'next/server';
import { marked } from 'marked';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { cleanSecret } from '@/lib/clean-env';
import { COL, type DocumentDoc } from '@/lib/collections';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MODEL = 'claude-sonnet-4-6';

export async function POST(req: Request) {
  const secret = cleanSecret(req.headers.get('x-worker-secret'));
  const expected = cleanSecret(process.env.WORKER_SECRET);
  if (expected && secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as { jobId?: string } | null;
  const jobId = body?.jobId?.trim();
  if (!jobId) return NextResponse.json({ error: 'jobId 必填' }, { status: 400 });

  const db = getFirestore();
  const jobRef = db.collection(COL.jobs).doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) return NextResponse.json({ skip: 'job 不存在' });

  const job = jobSnap.data() as {
    userId: string; characterId: string; brief: string; documentId: string; status: string;
  };
  if (job.status === 'done') return NextResponse.json({ skip: 'already done' });
  if (job.status === 'running') return NextResponse.json({ error: 'already running' }, { status: 409 });

  await jobRef.update({ status: 'running' });
  const docRef = db.collection(COL.documents).doc(job.documentId);

  try {
    const charSnap = await db.collection(COL.characters).doc(job.characterId).get();
    const char = charSnap.data() as { name?: string; soulCore?: string; soul?: string } | undefined;
    const soul = char?.soulCore?.trim() || char?.soul || '';
    const name = char?.name || '角色';

    await docRef.update({ status: 'writing' });
    const md = await writeMarkdown(name, soul, job.brief);

    await docRef.update({ status: 'rendering' });
    const docSnap = await docRef.get();
    const title = (docSnap.data() as DocumentDoc).title || name;
    const html = renderHtml(title, md);
    const htmlUrl = await uploadHtml(job.userId, job.documentId, html);

    await docRef.update({ mdContent: md, htmlUrl, status: 'done' });
    await jobRef.update({ status: 'done' });

    return NextResponse.json({ ok: true, htmlUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = /bridge (5\d\d|fetch|network|timeout)/i.test(msg) || /ECONN|ETIMEDOUT|fetch failed/i.test(msg);
    await jobRef.update({ status: retryable ? 'pending' : 'failed', error: msg }).catch((ue: unknown) => console.error('[doc-process] jobRef update failed:', ue));
    await docRef.update({ status: retryable ? 'pending' : 'failed', error: msg }).catch((ue: unknown) => console.error('[doc-process] docRef update failed:', ue));
    return NextResponse.json({ error: msg }, { status: retryable ? 500 : 200 });
  }
}

async function writeMarkdown(name: string, soul: string, brief: string): Promise<string> {
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '');
  const system = `${soul}

你是「${name}」。現在請你親自寫一份正式文件（策略書 / 企劃書）。
要求：用 markdown，結構清楚（標題、段落、條列、必要時表格）。
直接寫文件本身，不要寒暄、不要說明你要做什麼、不要前言後語。`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system,
    messages: [{ role: 'user', content: `請依以下要求寫這份文件：\n\n${brief}` }],
  });
  const text = res.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('').trim();
  if (!text) throw new Error('bridge 回傳空白');
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderHtml(title: string, md: string): string {
  const bodyHtml = marked.parse(md, { async: false }) as string;
  const now = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #1a1a1a; --ink-muted: #555; --ink-faint: #999; --line: #e5e5e5;
    --surface: #fafafa; --accent: #1a1a1a; --accent-light: #f0f0f0;
    --serif: "Georgia", "Noto Serif TC", "Source Han Serif TC", serif;
    --sans: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
    --mono: "JetBrains Mono", "Fira Code", "Courier New", monospace;
  }
  html { font-size: 16px; }
  body { font-family: var(--sans); color: var(--ink); background: #fff; line-height: 1.8; -webkit-font-smoothing: antialiased; }
  .page { max-width: 800px; margin: 0 auto; padding: 64px 48px 96px; }
  .doc-header { border-bottom: 2px solid var(--ink); padding-bottom: 28px; margin-bottom: 48px; }
  .doc-meta { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 12px; }
  .doc-title { font-family: var(--serif); font-size: 2rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; }
  .doc-body h1 { font-family: var(--serif); font-size: 1.6rem; font-weight: 700; margin-top: 56px; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .doc-body h2 { font-family: var(--sans); font-size: 1.1rem; font-weight: 700; margin-top: 40px; margin-bottom: 12px; }
  .doc-body h3 { font-family: var(--sans); font-size: 0.95rem; font-weight: 600; margin-top: 28px; margin-bottom: 8px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .doc-body p { font-size: 1rem; margin-bottom: 16px; }
  .doc-body ul, .doc-body ol { padding-left: 1.5em; margin-bottom: 16px; }
  .doc-body li { margin-bottom: 6px; font-size: 1rem; }
  .doc-body table { border-collapse: collapse; width: 100%; margin: 24px 0; font-size: 0.9rem; }
  .doc-body th { background: var(--ink); color: #fff; font-weight: 600; font-size: 0.8rem; letter-spacing: 0.06em; text-align: left; padding: 10px 14px; }
  .doc-body td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .doc-body tr:last-child td { border-bottom: none; }
  .doc-body tr:nth-child(even) td { background: var(--surface); }
  .doc-body blockquote { border-left: 3px solid var(--ink); margin: 24px 0; padding: 12px 20px; background: var(--surface); color: var(--ink-muted); font-style: italic; }
  .doc-body blockquote p { margin: 0; }
  .doc-body code { font-family: var(--mono); font-size: 0.85em; background: var(--accent-light); padding: 2px 6px; border-radius: 3px; }
  .doc-body pre { background: var(--ink); color: #e8e8e8; padding: 20px 24px; border-radius: 6px; overflow-x: auto; margin: 24px 0; }
  .doc-body pre code { background: none; padding: 0; color: inherit; font-size: 0.875rem; }
  .doc-body hr { border: none; border-top: 1px solid var(--line); margin: 40px 0; }
  .doc-footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 11px; color: var(--ink-faint); letter-spacing: 0.06em; display: flex; justify-content: space-between; }
  @media print { .page { padding: 0; } .doc-body h1, .doc-body h2 { break-after: avoid; } .doc-body table { break-inside: avoid; } }
  @media (max-width: 600px) { .page { padding: 32px 20px 64px; } .doc-title { font-size: 1.5rem; } }
</style></head>
<body>
  <div class="page">
    <header class="doc-header">
      <div class="doc-meta">ailiveX · ${escapeHtml(now)}</div>
      <h1 class="doc-title">${escapeHtml(title)}</h1>
    </header>
    <div class="doc-body">${bodyHtml}</div>
    <footer class="doc-footer">
      <span>由 ${escapeHtml(title)} 生成</span><span>ailiveX</span>
    </footer>
  </div>
</body></html>`;
}

async function uploadHtml(userId: string, documentId: string, html: string): Promise<string> {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error('FIREBASE_STORAGE_BUCKET 未設定');
  const path = `documents/${userId}/${documentId}.html`;
  const file = getFirebaseAdmin().storage().bucket(bucketName).file(path);
  await file.save(Buffer.from(html, 'utf-8'), {
    contentType: 'text/html; charset=utf-8',
    resumable: false,
  });
  return `https://storage.googleapis.com/${bucketName}/${path}`;
}
