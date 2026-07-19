/**
 * 知識提案（共創閘產物）—— GET 待審列表。
 * 提案只是候選文字；審核動作在 [pid] route（approve 走 ingestKnowledgeDoc 正式管線）。
 * /api/admin* 由 middleware 限 admin。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type KnowledgeProposalDoc } from '@/lib/collections';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.knowledgeProposals)
    .where('characterId', '==', id)
    .where('status', '==', 'draft')
    .get();
  const items = snap.docs
    .map(d => {
      const p = d.data() as KnowledgeProposalDoc;
      return {
        id: d.id,
        title: p.title,
        content: p.content,
        sourceNote: p.sourceNote ?? '',
        createdAt: p.createdAt instanceof Date
          ? p.createdAt.getTime()
          : (p.createdAt as { toMillis(): number })?.toMillis?.() ?? null,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return NextResponse.json({ proposals: items });
}
