/**
 * ailiveX doc worker（Cloud Run）—— 把對話中 [[DOCUMENT]] 排的 job 產出成 HTML。
 *
 * 流程：job → 載角色 soulCore + brief → bridge 寫 markdown → marked 轉 HTML
 *      → 上 GCS（public）→ 更新 documents.htmlUrl + status=done。
 *
 * 紀律：job 狀態把關（pending 才做）；失敗設 failed（不是 running）；
 *      生成失敗回 200 不讓 Cloud Tasks 無限重試；bridge 連線失敗回 500 可重排。
 */
import express from 'express';
import admin from 'firebase-admin';
import { marked } from 'marked';
const PORT = Number(process.env.PORT) || 8080;
const MODEL = 'claude-sonnet-4-6';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});
const db = admin.firestore();
const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => { res.json({ ok: true }); });
app.post('/process', async (req, res) => {
    const jobId = req.body?.jobId;
    if (!jobId) {
        res.status(400).json({ error: 'jobId 必填' });
        return;
    }
    const jobRef = db.collection('jobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
        res.status(200).json({ skip: 'job 不存在' });
        return;
    }
    const job = jobSnap.data();
    if (job.status === 'done') {
        res.status(200).json({ skip: 'already done' });
        return;
    }
    if (job.status === 'running') {
        res.status(409).json({ error: 'already running' });
        return;
    }
    await jobRef.update({ status: 'running' });
    const docRef = db.collection('documents').doc(job.documentId);
    try {
        const charSnap = await db.collection('characters').doc(job.characterId).get();
        const char = charSnap.data();
        const soul = (char?.soulCore?.trim() || char?.soul || '');
        const name = char?.name || '角色';
        await docRef.update({ status: 'writing' });
        const md = await writeMarkdown(name, soul, job.brief);
        await docRef.update({ status: 'rendering' });
        const html = renderHtml(name, md);
        const htmlUrl = await uploadHtml(job.userId, job.documentId, html);
        await docRef.update({ mdContent: md, htmlUrl, status: 'done' });
        await jobRef.update({ status: 'done' });
        res.status(200).json({ ok: true, htmlUrl });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = /bridge (5\d\d|fetch|network|timeout)/i.test(msg) || /ECONN|ETIMEDOUT|fetch failed/i.test(msg);
        await jobRef.update({ status: retryable ? 'pending' : 'failed', error: msg }).catch(() => { });
        await docRef.update({ status: retryable ? 'pending' : 'failed', error: msg }).catch(() => { });
        // 可重試 → 500 讓 Cloud Tasks 重排；不可重試 → 200 收掉
        res.status(retryable ? 500 : 200).json({ error: msg });
    }
});
async function writeMarkdown(name, soul, brief) {
    const url = (process.env.BRIDGE_URL || '').replace(/\/$/, '');
    const secret = process.env.BRIDGE_SECRET || '';
    const system = `${soul}

你是「${name}」。現在請你親自寫一份正式文件（策略書 / 企劃書）。
要求：用 markdown，結構清楚（標題、段落、條列、必要時表格）。
直接寫文件本身，不要寒暄、不要說明你要做什麼、不要前言後語。`;
    const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 8192,
            system,
            messages: [{ role: 'user', content: `請依以下要求寫這份文件：\n\n${brief}` }],
        }),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`bridge ${r.status}: ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('').trim();
    if (!text)
        throw new Error('bridge 回傳空白');
    return text;
}
function renderHtml(title, md) {
    const bodyHtml = marked.parse(md, { async: false });
    const now = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --ink: #1a1a1a;
    --ink-muted: #555;
    --ink-faint: #999;
    --line: #e5e5e5;
    --surface: #fafafa;
    --accent: #1a1a1a;
    --accent-light: #f0f0f0;
    --serif: "Georgia", "Noto Serif TC", "Source Han Serif TC", serif;
    --sans: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
    --mono: "JetBrains Mono", "Fira Code", "Courier New", monospace;
  }

  html { font-size: 16px; }

  body {
    font-family: var(--sans);
    color: var(--ink);
    background: #fff;
    line-height: 1.8;
    -webkit-font-smoothing: antialiased;
  }

  /* ── 頁面框架 ── */
  .page {
    max-width: 800px;
    margin: 0 auto;
    padding: 64px 48px 96px;
  }

  /* ── 文件頭 ── */
  .doc-header {
    border-bottom: 2px solid var(--ink);
    padding-bottom: 28px;
    margin-bottom: 48px;
  }
  .doc-meta {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-bottom: 12px;
    font-family: var(--sans);
  }
  .doc-title {
    font-family: var(--serif);
    font-size: 2rem;
    font-weight: 700;
    line-height: 1.25;
    color: var(--ink);
    letter-spacing: -0.01em;
  }

  /* ── 正文排版 ── */
  .doc-body h1 {
    font-family: var(--serif);
    font-size: 1.6rem;
    font-weight: 700;
    margin-top: 56px;
    margin-bottom: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
    letter-spacing: -0.01em;
  }
  .doc-body h2 {
    font-family: var(--sans);
    font-size: 1.1rem;
    font-weight: 700;
    margin-top: 40px;
    margin-bottom: 12px;
    color: var(--ink);
    letter-spacing: 0.01em;
  }
  .doc-body h3 {
    font-family: var(--sans);
    font-size: 0.95rem;
    font-weight: 600;
    margin-top: 28px;
    margin-bottom: 8px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .doc-body p {
    font-size: 1rem;
    margin-bottom: 16px;
    color: var(--ink);
  }
  .doc-body ul, .doc-body ol {
    padding-left: 1.5em;
    margin-bottom: 16px;
  }
  .doc-body li {
    margin-bottom: 6px;
    font-size: 1rem;
  }
  .doc-body li + li { margin-top: 4px; }

  /* ── 表格 ── */
  .doc-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 24px 0;
    font-size: 0.9rem;
  }
  .doc-body th {
    background: var(--ink);
    color: #fff;
    font-weight: 600;
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-align: left;
    padding: 10px 14px;
  }
  .doc-body td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .doc-body tr:last-child td { border-bottom: none; }
  .doc-body tr:nth-child(even) td { background: var(--surface); }

  /* ── 引用塊 ── */
  .doc-body blockquote {
    border-left: 3px solid var(--ink);
    margin: 24px 0;
    padding: 12px 20px;
    background: var(--surface);
    color: var(--ink-muted);
    font-style: italic;
  }
  .doc-body blockquote p { margin: 0; }

  /* ── 程式碼 ── */
  .doc-body code {
    font-family: var(--mono);
    font-size: 0.85em;
    background: var(--accent-light);
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--ink);
  }
  .doc-body pre {
    background: var(--ink);
    color: #e8e8e8;
    padding: 20px 24px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 24px 0;
  }
  .doc-body pre code {
    background: none;
    padding: 0;
    color: inherit;
    font-size: 0.875rem;
  }

  /* ── 分隔線 ── */
  .doc-body hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 40px 0;
  }

  /* ── 頁尾 ── */
  .doc-footer {
    margin-top: 64px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.06em;
    display: flex;
    justify-content: space-between;
  }

  /* ── 列印優化 ── */
  @media print {
    .page { padding: 0; }
    .doc-body h1, .doc-body h2 { break-after: avoid; }
    .doc-body table { break-inside: avoid; }
  }

  @media (max-width: 600px) {
    .page { padding: 32px 20px 64px; }
    .doc-title { font-size: 1.5rem; }
  }
</style></head>
<body>
  <div class="page">
    <header class="doc-header">
      <div class="doc-meta">ailiveX · ${escapeHtml(now)}</div>
      <h1 class="doc-title">${escapeHtml(title)}</h1>
    </header>
    <div class="doc-body">${bodyHtml}</div>
    <footer class="doc-footer">
      <span>由 ${escapeHtml(title)} 生成</span>
      <span>ailiveX</span>
    </footer>
  </div>
</body></html>`;
}
function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
async function uploadHtml(userId, documentId, html) {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName)
        throw new Error('FIREBASE_STORAGE_BUCKET 未設定');
    const path = `documents/${userId}/${documentId}.html`;
    const file = admin.storage().bucket(bucketName).file(path);
    await file.save(Buffer.from(html, 'utf-8'), {
        contentType: 'text/html; charset=utf-8',
        resumable: false,
    });
    return `https://storage.googleapis.com/${bucketName}/${path}`;
}
app.listen(PORT, () => { console.log(`[doc-worker] listening on ${PORT}`); });
