/**
 * 角色方法論管理 —— GET 列表 / POST 新增（只對 triggerDesc 做 embedding，steps 不切塊）。
 * /api/admin* 由 middleware 限 admin。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type MethodologyDoc } from '@/lib/collections';
import { generateKnowledgeEmbedding } from '@/lib/embeddings';
import { sanitizeSteps, MAX_STEPS } from '@/lib/methodology';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.methodologies)
    .where('characterId', '==', id)
    .get();
  const items = snap.docs
    .map(d => {
      const m = d.data() as MethodologyDoc;
      return {
        id: d.id,
        name: m.name,
        purpose: m.purpose,
        triggerDesc: m.triggerDesc,
        preconditions: m.preconditions || [],
        steps: m.steps || [],
        status: m.status,
        createdAt: m.createdAt instanceof Date
          ? m.createdAt.getTime()
          : (m.createdAt as { toMillis(): number })?.toMillis?.() ?? null,
      };
    })
    // draft（角色在 admin 對話中的提案）一併帶出給後台審核；archived 不出
    .filter(m => m.status === 'active' || m.status === 'draft')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return NextResponse.json({ methodologies: items });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as {
    name?: string; purpose?: string; triggerDesc?: string;
    preconditions?: string[]; steps?: unknown;
  } | null;

  const name = body?.name?.trim();
  const purpose = body?.purpose?.trim();
  const triggerDesc = body?.triggerDesc?.trim();
  const steps = sanitizeSteps(body?.steps);

  if (!name || !purpose || !triggerDesc) {
    return NextResponse.json({ error: 'name / purpose / triggerDesc 必填' }, { status: 400 });
  }
  if (!steps) {
    return NextResponse.json({ error: `steps 需為 1-${MAX_STEPS} 步、每步含 instruction` }, { status: 400 });
  }

  const db = getFirestore();
  const charSnap = await db.collection(COL.characters).doc(id).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  const triggerEmb = await generateKnowledgeEmbedding(triggerDesc, 'document').catch(() => null);

  const doc: MethodologyDoc = {
    characterId: id,
    name,
    purpose,
    triggerDesc,
    ...(triggerEmb ? { triggerEmb } : {}),
    preconditions: (Array.isArray(body?.preconditions) ? body.preconditions : [])
      .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()),
    steps,
    status: 'active',
    createdAt: new Date(),
  };
  const ref = await db.collection(COL.methodologies).add(doc);

  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection(COL.characters).doc(id)
    .update({ methodologyCount: FieldValue.increment(1) });

  return NextResponse.json({ ok: true, id: ref.id, embedded: !!triggerEmb });
}
