/**
 * GET /api/convert/podcast/scripts
 * 列出當前使用者所有已生成腳本的 podcast task（status=scripted|done）
 * Returns: { scripts: ScriptItem[] }
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type TaskDoc, type PodcastLine } from '@/lib/collections';

export const runtime = 'nodejs';

export interface ScriptItem {
  id: string;
  topic: string;
  focus: string;
  characterIds: string[];
  speakers: string[];
  wordCount: number;
  script: PodcastLine[];
  audioUrl: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const snap = await db.collection(COL.tasks)
    .where('userId', '==', user.uid)
    .where('type', '==', 'podcast_generation')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  // running/failed 也要回——「背景有任務但前端看不到」是斷點，任務從建立那一刻就要可見
  const scripts: ScriptItem[] = snap.docs
    .flatMap(d => {
      const t = d.data() as TaskDoc & { audioUrl?: string };
      const script = t.podcastScript ?? [];
      if (!script.length && t.status !== 'running' && t.status !== 'failed') return [];
      const words = script.reduce((s, l) => s + l.text.length, 0);
      const speakers = [...new Set(script.map(l => l.speaker))];
      const item: ScriptItem = {
        id: d.id,
        topic: t.podcastTopic ?? '',
        focus: t.podcastFocus ?? '',
        characterIds: t.podcastCharacterIds ?? [],
        speakers,
        wordCount: words,
        script,
        audioUrl: t.audioUrl ?? null,
        status: String(t.status),
        error: t.error ?? null,
        createdAt: t.createdAt instanceof Date ? t.createdAt.getTime()
          : (t.createdAt as { toMillis?: () => number })?.toMillis?.() ?? Date.now(),
      };
      return [item];
    });

  return NextResponse.json({ scripts });
}
