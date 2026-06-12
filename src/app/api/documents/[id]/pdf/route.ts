import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type DocumentDoc } from '@/lib/collections';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.documents).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  const doc = snap.data() as DocumentDoc;
  if (doc.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!doc.htmlUrl) return NextResponse.json({ error: '文件尚未生成' }, { status: 400 });

  // Dynamic import — keeps bundle small in dev, only loads in nodejs runtime
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = (await import('puppeteer-core')).default;

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.goto(doc.htmlUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    const filename = encodeURIComponent(doc.title.slice(0, 60)) + '.pdf';
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } finally {
    await browser.close();
  }
}
