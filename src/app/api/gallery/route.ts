import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

function toMillis(v: TaskDoc['createdAt'] | undefined): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  return (v as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
}

// 圖庫 + 製圖任務排程：當前用戶所有 image_generation 任務
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const snap = await db.collection(COL.tasks)
    .where('userId', '==', user.uid)
    .get();

  const tasks = snap.docs
    .map(d => ({ id: d.id, ...(d.data() as TaskDoc) }))
    .filter(t => t.type === 'image_generation')
    .map(t => ({
      id: t.id,
      characterId: t.characterId,
      intent: t.intent || '',
      summary: t.summary || '',
      status: t.status,
      imageUrl: t.imageUrl || '',
      error: t.error || '',
      createdAt: toMillis(t.createdAt),
      completedAt: toMillis(t.completedAt),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ tasks });
}
