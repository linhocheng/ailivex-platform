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

// running 超過此時長＝生成已中斷（Job 硬上限 1h、正常腳本 ~25 分、音檔 ~10 分）。
// 讀取時驗屍寫回 failed——防禦釘在收斂點，永遠不會再有永久轉圈的殭屍卡片（7/2 曾卡 5 天）。
const STALE_RUNNING_MS = 45 * 60_000;

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

  const now = Date.now();
  const staleWrites: Promise<unknown>[] = [];

  // running/failed 也要回——「背景有任務但前端看不到」是斷點，任務從建立那一刻就要可見
  const scripts: ScriptItem[] = snap.docs
    .flatMap(d => {
      const t = d.data() as TaskDoc & { audioUrl?: string; phaseStartedAt?: { toMillis?: () => number } };
      const script = t.podcastScript ?? [];
      if (!script.length && t.status !== 'running' && t.status !== 'failed') return [];

      let status = String(t.status);
      let error: string | null = t.error ?? null;
      const phaseStart = t.phaseStartedAt?.toMillis?.()
        ?? (t.createdAt as { toMillis?: () => number })?.toMillis?.()
        ?? now;
      if (status === 'running' && now - phaseStart > STALE_RUNNING_MS) {
        status = 'failed';
        error = '生成逾時，已自動停止——可按「重啟」再跑一次';
        staleWrites.push(d.ref.update({ status, error }).catch(() => {}));
      }

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
        status,
        error,
        createdAt: t.createdAt instanceof Date ? t.createdAt.getTime()
          : (t.createdAt as { toMillis?: () => number })?.toMillis?.() ?? Date.now(),
      };
      return [item];
    });

  if (staleWrites.length) await Promise.all(staleWrites);

  return NextResponse.json({ scripts });
}
