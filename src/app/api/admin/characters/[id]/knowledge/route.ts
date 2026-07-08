/**
 * 角色知識庫（著作層）管理 —— GET 列表 / POST 入庫（貼文字 → 程式切塊 → embedding）。
 * authority 是編輯責任：上傳的人標 canonical/paraphrase/derived，系統不猜。
 * /api/admin* 由 middleware 限 admin。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type KnowledgeDocDoc, type KnowledgeDocType, type KnowledgeAuthority } from '@/lib/collections';
import { ingestKnowledgeDoc } from '@/lib/knowledge';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

export const runtime = 'nodejs';
export const maxDuration = 300; // 大文本入庫要跑 N 次 embedding

type Params = { params: Promise<{ id: string }> };

const DOC_TYPES: KnowledgeDocType[] = ['book', 'article', 'talk', 'interview', 'note'];
const AUTHORITIES: KnowledgeAuthority[] = ['canonical', 'paraphrase', 'derived'];
const MAX_CONTENT_CHARS = 200_000; // 入庫單次上限（約 400 塊；再大請分批貼）

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.knowledgeDocs)
    .where('characterId', '==', id)
    .get();
  const docs = snap.docs
    .map(d => {
      const k = d.data() as KnowledgeDocDoc;
      return {
        id: d.id,
        title: k.title,
        docType: k.docType,
        authority: k.authority,
        sourceRef: k.sourceRef || '',
        chunkCount: k.chunkCount,
        status: k.status,
        createdAt: k.createdAt instanceof Date
          ? k.createdAt.getTime()
          : (k.createdAt as { toMillis(): number })?.toMillis?.() ?? null,
      };
    })
    .filter(k => k.status === 'active')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return NextResponse.json({ docs });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as {
    title?: string; docType?: string; authority?: string; sourceRef?: string; content?: string;
  } | null;

  const title = body?.title?.trim();
  const content = body?.content?.trim();
  const docType = body?.docType as KnowledgeDocType;
  const authority = body?.authority as KnowledgeAuthority;

  if (!title || !content) return NextResponse.json({ error: 'title 與 content 必填' }, { status: 400 });
  if (!DOC_TYPES.includes(docType)) return NextResponse.json({ error: `docType 需為 ${DOC_TYPES.join('/')}` }, { status: 400 });
  if (!AUTHORITIES.includes(authority)) return NextResponse.json({ error: `authority 需為 ${AUTHORITIES.join('/')}` }, { status: 400 });
  if (content.length > MAX_CONTENT_CHARS) {
    return NextResponse.json({ error: `content 超過 ${MAX_CONTENT_CHARS} 字上限，請分批入庫` }, { status: 400 });
  }

  const db = getFirestore();
  const charSnap = await db.collection(COL.characters).doc(id).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  try {
    // bridge client 給白話大意索引用（吃到飽；bridge 沒起時 SDK 直連）
    const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '');
    const result = await ingestKnowledgeDoc(db, id, {
      title, docType, authority, sourceRef: body?.sourceRef, content,
    }, client);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/knowledge] ingest failed:', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: '入庫失敗：' + (e instanceof Error ? e.message : '未知錯誤') }, { status: 500 });
  }
}
