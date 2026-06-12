import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type DocumentDoc } from '@/lib/collections';

export const runtime = 'nodejs';

// 我的文件：只列當前用戶自己的文件
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const snap = await db.collection(COL.documents)
    .where('userId', '==', user.uid)
    .get();

  const documents = snap.docs
    .map(d => {
      const doc = d.data() as DocumentDoc;
      const created = doc.createdAt instanceof Date
        ? doc.createdAt.getTime()
        : (doc.createdAt as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
      return {
        id: d.id,
        title: doc.title,
        status: doc.status,
        htmlUrl: doc.htmlUrl || '',
        characterId: doc.characterId,
        createdAt: created,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ documents });
}
