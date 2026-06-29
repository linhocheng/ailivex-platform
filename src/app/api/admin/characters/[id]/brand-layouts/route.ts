/**
 * GET  /api/admin/characters/[id]/brand-layouts — 列出該角色所有 layouts
 * POST /api/admin/characters/[id]/brand-layouts — 上傳新 layout（binary image body）
 *   headers: x-name, x-description, x-is-default (optional "true")
 */
import { NextResponse } from 'next/server';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type BrandLayoutDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (user?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

    const { id: characterId } = await params;
    const db = getFirestore();
    const snap = await db.collection(COL.brandLayouts)
      .where('characterId', '==', characterId)
      .orderBy('createdAt', 'desc')
      .get();

    const layouts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ layouts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[brand-layouts GET]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (user?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

    const { id: characterId } = await params;
    const name = decodeURIComponent(req.headers.get('x-name') || '').trim();
    const description = decodeURIComponent(req.headers.get('x-description') || '').trim();
    const isDefault = req.headers.get('x-is-default') === 'true';
    const contentType = req.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return NextResponse.json({ error: '僅允許上傳圖片' }, { status: 400 });

    if (!name) return NextResponse.json({ error: 'x-name 必填' }, { status: 400 });

    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return NextResponse.json({ error: 'empty_body' }, { status: 400 });

    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) return NextResponse.json({ error: 'FIREBASE_STORAGE_BUCKET not set' }, { status: 503 });

    const db = getFirestore();
    const docRef = db.collection(COL.brandLayouts).doc();
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const gcsPath = `brand-assets/${characterId}/layouts/${docRef.id}.${ext}`;

    const bucket = getFirebaseAdmin().storage().bucket(bucketName);
    const file = bucket.file(gcsPath);
    await file.save(Buffer.from(buf), { contentType, resumable: false });
    const imageUrl = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;

    if (isDefault) {
      const existing = await db.collection(COL.brandLayouts)
        .where('characterId', '==', characterId)
        .where('isDefault', '==', true)
        .get();
      const batch = db.batch();
      existing.docs.forEach(d => batch.update(d.ref, { isDefault: false }));
      await batch.commit();
    }

    const doc: BrandLayoutDoc = {
      characterId, name, description, imageUrl, isDefault,
      createdAt: new Date(),
    };
    await docRef.set(doc);

    return NextResponse.json({ id: docRef.id, imageUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[brand-layouts POST]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
