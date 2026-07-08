/**
 * POST /api/agent/memory-blocks — 語音 agent 進房時要「組好的記憶塊」（第 3.5 期，2026-07-08）
 *
 * 真相一份在 TS：印象模式（◆◇～/consolidatedInto 過濾/canary）與日記塊
 * 全部 reuse loadMemoryBlock / loadDiaryBlock，這裡零新邏輯，只是給 agent 的取塊窗口。
 * canary 收斂在此側：canary 外用戶拿到的就是舊格式塊，Python 端不知道 canary 存在。
 *
 * 鑑權：x-worker-secret（agent cloudbuild 已注入同名 secret）。
 * 架構全文：docs/memory-panorama-voice-integration.md
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { loadMemoryBlock } from '@/lib/memory';
import { loadDiaryBlock } from '@/lib/diary';
import { verifyWorkerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyWorkerSecret(req.headers.get('x-worker-secret'), process.env.WORKER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized', from: 'memory-blocks' }, { status: 401 });
  }
  const body = await req.json().catch(() => null) as { userId?: string; characterId?: string; query?: string } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  if (!userId || !characterId) {
    return NextResponse.json({ error: 'userId 與 characterId 必填' }, { status: 400 });
  }

  const db = getFirestore();
  const [memoryBlock, diaryBlock] = await Promise.all([
    loadMemoryBlock(db, userId, characterId, body?.query).catch(e => {
      console.error('[memory-blocks] loadMemoryBlock failed:', e instanceof Error ? e.message : String(e));
      return '';
    }),
    loadDiaryBlock(db, userId, characterId).catch(e => {
      console.error('[memory-blocks] loadDiaryBlock failed:', e instanceof Error ? e.message : String(e));
      return '';
    }),
  ]);

  return NextResponse.json({ memoryBlock, diaryBlock });
}
