import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc } from '@/lib/collections';

export const runtime = 'nodejs';

const GALLERY_TYPES = ['image_generation', 'audio_generation', 'script_draft'];

function toMillis(v: TaskDoc['createdAt'] | undefined): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  return (v as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
}

// 媒體庫：圖片 + 音檔 + 腳本草稿
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const snap = await db.collection(COL.tasks)
    .where('userId', '==', user.uid)
    .where('type', 'in', GALLERY_TYPES)
    .get();

  const raw = snap.docs.map(d => ({ id: d.id, ...(d.data() as TaskDoc & Record<string, unknown>) }));

  const tasks = raw.map(t => ({
    id: t.id,
    type: t.type as string,
    characterId: t.characterId,
    intent: t.intent || '',
    summary: (t.summary as string) || '',
    status: t.status as string,
    imageUrl: (t.imageUrl as string) || '',
    audioUrl: (t.audioUrl as string) || '',
    scriptText: (t.scriptText as string) || '',
    voiceId: (t.voiceId as string) || '',
    error: (t.error as string) || '',
    createdAt: toMillis(t.createdAt),
    completedAt: toMillis(t.completedAt as TaskDoc['createdAt']),
  })).sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ tasks });
}
