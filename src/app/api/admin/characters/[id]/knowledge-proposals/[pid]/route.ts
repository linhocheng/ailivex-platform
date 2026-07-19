/**
 * 單一知識提案 —— PATCH action='approve' 轉入庫（走 ingestKnowledgeDoc 正式管線：
 * 切塊＋gist＋embedding＋計數）/ DELETE 退回。
 * authority 固定 'derived'（角色整理的內容，不是本人原話）——要更高權威度請 admin 走手動入庫。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type KnowledgeProposalDoc } from '@/lib/collections';
import { ingestKnowledgeDoc } from '@/lib/knowledge';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

export const runtime = 'nodejs';
export const maxDuration = 300;   // ingest 含 gist 批次（bridge LLM），長內容要時間

type Params = { params: Promise<{ id: string; pid: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id, pid } = await params;
  const body = await req.json().catch(() => null) as { action?: string } | null;
  if (body?.action !== 'approve') {
    return NextResponse.json({ error: '只支援 action=approve' }, { status: 400 });
  }

  const db = getFirestore();
  const ref = db.collection(COL.knowledgeProposals).doc(pid);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '提案不存在' }, { status: 404 });
  const p = snap.data() as KnowledgeProposalDoc;
  if (p.characterId !== id) return NextResponse.json({ error: '提案不屬於此角色' }, { status: 400 });
  if (p.status !== 'draft') return NextResponse.json({ error: '只有待審提案可以轉入庫' }, { status: 400 });

  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '');
  const r = await ingestKnowledgeDoc(db, id, {
    title: p.title,
    docType: 'note',
    authority: 'derived',
    sourceRef: `共創提案轉入（${p.sourceNote || '對話'}）`,
    content: p.content,
  }, client);

  await ref.update({ status: 'ingested', ingestedDocId: r.documentId });
  return NextResponse.json({ ok: true, documentId: r.documentId, chunkCount: r.chunkCount });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, pid } = await params;
  const db = getFirestore();
  const ref = db.collection(COL.knowledgeProposals).doc(pid);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '提案不存在' }, { status: 404 });
  if ((snap.data() as KnowledgeProposalDoc).characterId !== id) {
    return NextResponse.json({ error: '提案不屬於此角色' }, { status: 400 });
  }
  await ref.delete();
  return NextResponse.json({ ok: true });
}
