/**
 * 單一知識文件 —— DELETE 刪除（連 chunks 一起清，計數同步遞減）。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type KnowledgeDocDoc } from '@/lib/collections';
import { deleteKnowledgeDoc } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string; docId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const { id, docId } = await params;
  const db = getFirestore();

  const snap = await db.collection(COL.knowledgeDocs).doc(docId).get();
  if (!snap.exists) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  if ((snap.data() as KnowledgeDocDoc).characterId !== id) {
    return NextResponse.json({ error: '文件不屬於此角色' }, { status: 400 });
  }

  const result = await deleteKnowledgeDoc(db, id, docId);
  return NextResponse.json({ ok: true, ...result });
}
