/**
 * GET /api/admin/podcasts
 * 全部用戶的 podcast 任務總表（admin-only，middleware 已擋）。
 * 避 composite index：只用 equality filter，JS 端排序。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type TaskDoc, type UserDoc } from '@/lib/collections';

export const runtime = 'nodejs';

export async function GET() {
  const db = getFirestore();
  const [taskSnap, userSnap] = await Promise.all([
    db.collection(COL.tasks).where('type', '==', 'podcast_generation').get(),
    db.collection(COL.users).get(),
  ]);

  const uidName: Record<string, string> = {};
  userSnap.docs.forEach(d => { uidName[d.id] = (d.data() as UserDoc).username ?? d.id; });

  const podcasts = taskSnap.docs
    .map(d => {
      const t = d.data() as TaskDoc & { audioUrl?: string };
      const words = t.podcastScript?.reduce((s, l) => s + l.text.length, 0) ?? 0;
      const speakers = [...new Set((t.podcastScript ?? []).map(l => l.speaker))];
      return {
        id: d.id,
        owner: uidName[t.userId] ?? t.userId,
        topic: t.podcastTopic ?? '',
        speakers,
        wordCount: words,
        script: t.podcastScript ?? [],
        audioUrl: t.audioUrl ?? null,
        status: String(t.status),
        createdAt: (t.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ podcasts });
}
