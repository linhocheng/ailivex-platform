/**
 * GET /api/stories
 * 列出當前用戶所有 story_draft tasks，並附帶每個故事的圖卡數量。
 */
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

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const [storiesSnap, cardsSnap] = await Promise.all([
    db.collection(COL.tasks).where('userId', '==', user.uid).where('type', '==', 'story_draft').get(),
    db.collection(COL.tasks).where('userId', '==', user.uid).where('type', '==', 'image_generation').get(),
  ]);

  // 統計每個 story 的圖卡數
  const cardCount: Record<string, number> = {};
  const doneCount: Record<string, number> = {};
  cardsSnap.docs.forEach(d => {
    const parentId = d.data().parentTaskId as string | undefined;
    if (!parentId) return;
    cardCount[parentId] = (cardCount[parentId] ?? 0) + 1;
    if (d.data().status === 'done') doneCount[parentId] = (doneCount[parentId] ?? 0) + 1;
  });

  const stories = storiesSnap.docs.map(d => {
    const t = d.data() as TaskDoc & Record<string, unknown>;
    return {
      id: d.id,
      intent: t.intent || '',
      characterId: t.characterId,
      status: t.status as string,
      storyText: ((t.storyText as string) || '').slice(0, 80),
      cardCount: cardCount[d.id] ?? 0,
      doneCount: doneCount[d.id] ?? 0,
      error: (t.error as string) || '',
      createdAt: toMillis(t.createdAt),
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ stories });
}
