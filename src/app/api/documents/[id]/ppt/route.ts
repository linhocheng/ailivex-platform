import { NextResponse } from 'next/server';
import { createSign } from 'crypto';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type DocumentDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// ── JWT + token ───────────────────────────────────────────────────────────────
const JWT_EXPIRY_SECONDS = 3600;

function buildJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/drive',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function getToken(sa: ServiceAccount): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildJwt(sa),
    }),
  });
  const d = await r.json() as { access_token?: string; error?: string };
  if (!d.access_token) throw new Error(`Google token error: ${JSON.stringify(d)}`);
  return d.access_token;
}

// ── Markdown → [{title, bullets}] ────────────────────────────────────────────
function parseSlides(md: string): Array<{ title: string; bullets: string[] }> {
  const slides: Array<{ title: string; bullets: string[] }> = [];
  let cur: { title: string; bullets: string[] } | null = null;
  for (const line of md.split('\n')) {
    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    const bullet = line.match(/^[-*] (.+)/) || line.match(/^\d+\. (.+)/);
    const text = line.trim();
    if (h1 || h2) {
      if (cur) slides.push(cur);
      cur = { title: (h1 || h2)![1], bullets: [] };
    } else if (h3 && cur) {
      slides.push(cur);
      cur = { title: h3[1], bullets: [] };
    } else if (bullet && cur) {
      cur.bullets.push(bullet[1]);
    } else if (text && cur && !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('---')) {
      cur.bullets.push(text);
    }
  }
  if (cur) slides.push(cur);
  return slides.filter(s => s.title || s.bullets.length > 0);
}

// ── Google Slides helpers ─────────────────────────────────────────────────────
const EMU = (inches: number) => Math.round(inches * 914400);
const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });

const DARK_BG   = rgb(15, 15, 15);
const WHITE     = rgb(255, 255, 255);
const BODY_CLR  = rgb(204, 204, 204);
const MUTED_CLR = rgb(100, 100, 100);

function bgRequest(slideId: string) {
  return {
    updatePageProperties: {
      objectId: slideId,
      pageProperties: {
        pageBackgroundFill: { solidFill: { color: { rgbColor: DARK_BG } } },
      },
      fields: 'pageBackgroundFill',
    },
  };
}

function textBox(slideId: string, objId: string, x: number, y: number, w: number, h: number) {
  return {
    createShape: {
      objectId: objId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: slideId,
        size: {
          width:  { magnitude: EMU(w), unit: 'EMU' },
          height: { magnitude: EMU(h), unit: 'EMU' },
        },
        transform: { scaleX: 1, scaleY: 1, translateX: EMU(x), translateY: EMU(y), unit: 'EMU' },
      },
    },
  };
}

function textStyle(objId: string, size: number, color: ReturnType<typeof rgb>, bold = false) {
  return {
    updateTextStyle: {
      objectId: objId,
      style: {
        fontSize: { magnitude: size, unit: 'PT' },
        bold,
        foregroundColor: { opaqueColor: { rgbColor: color } },
        fontFamily: 'Arial',
      },
      fields: 'fontSize,bold,foregroundColor,fontFamily',
    },
  };
}

function buildCoverRequests(slideId: string, title: string): object[] {
  const titleId = `${slideId}_t`;
  const brandId = `${slideId}_b`;
  return [
    bgRequest(slideId),
    textBox(slideId, titleId, 0.5, 1.5, 9, 1.6),
    { insertText: { objectId: titleId, text: title } },
    textStyle(titleId, 34, WHITE, true),
    textBox(slideId, brandId, 0.5, 4.8, 4, 0.35),
    { insertText: { objectId: brandId, text: 'ailiveX' } },
    textStyle(brandId, 13, MUTED_CLR),
  ];
}

function buildContentRequests(slideId: string, title: string, bullets: string[]): object[] {
  const titleId = `${slideId}_t`;
  const bodyId  = `${slideId}_b`;
  const truncated = bullets.slice(0, 8).map(b => b.length > 120 ? b.slice(0, 120) + '…' : b);
  const bodyText = truncated.join('\n');
  return [
    bgRequest(slideId),
    textBox(slideId, titleId, 0.5, 0.35, 9, 0.75),
    { insertText: { objectId: titleId, text: title } },
    textStyle(titleId, 22, WHITE, true),
    ...(bodyText ? [
      textBox(slideId, bodyId, 0.5, 1.3, 9, 4.0),
      { insertText: { objectId: bodyId, text: bodyText } },
      textStyle(bodyId, 15, BODY_CLR),
      {
        createParagraphBullets: {
          objectId: bodyId,
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ] : []),
  ];
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.documents).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  const doc = snap.data() as DocumentDoc;
  if (doc.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!doc.mdContent) return NextResponse.json({ error: '文件尚未生成' }, { status: 400 });

  // Return cached URL if already created
  if (doc.slidesUrl) return NextResponse.json({ slidesUrl: doc.slidesUrl });

  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!saRaw) return NextResponse.json({ error: 'missing service account' }, { status: 500 });
  const sa: ServiceAccount = JSON.parse(saRaw);
  const token = await getToken(sa);

  const authHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. Create empty presentation
  const createResp = await fetch('https://slides.googleapis.com/v1/presentations', {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ title: doc.title }),
  });
  const created = await createResp.json() as { presentationId: string; slides?: Array<{ objectId: string }> };
  const pid = created.presentationId;

  // 2. Build batch requests
  const requests: object[] = [];

  // Delete the default blank slide Google creates
  const defaultSlide = created.slides?.[0]?.objectId;
  if (defaultSlide) requests.push({ deleteObject: { objectId: defaultSlide } });

  // Cover slide
  const coverId = 'slide_cover';
  requests.push({ addSlide: { objectId: coverId, insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
  requests.push(...buildCoverRequests(coverId, doc.title));

  // Content slides
  const slides = parseSlides(doc.mdContent);
  slides.forEach((s, i) => {
    const sid = `slide_${i}`;
    requests.push({ addSlide: { objectId: sid, insertionIndex: i + 1, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
    requests.push(...buildContentRequests(sid, s.title, s.bullets));
  });

  // 3. batchUpdate
  const batchResp = await fetch(`https://slides.googleapis.com/v1/presentations/${pid}:batchUpdate`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ requests }),
  });
  if (!batchResp.ok) {
    const err = await batchResp.json();
    return NextResponse.json({ error: 'slides build failed', detail: err }, { status: 500 });
  }

  // 4. Make publicly viewable via Drive API
  await fetch(`https://www.googleapis.com/drive/v3/files/${pid}/permissions`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const slidesUrl = `https://docs.google.com/presentation/d/${pid}/edit`;

  // 5. Cache URL in Firestore
  await db.collection(COL.documents).doc(id).update({ slidesUrl });

  return NextResponse.json({ slidesUrl });
}
