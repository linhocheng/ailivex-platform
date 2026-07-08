/**
 * POST /api/agent/extract-memories — 語音掛斷後記憶提煉走 TS（連線批次①，2026-07-08）
 *
 * 殺雙實作債：文字道的 extractAndSaveMemories（lib/memory.ts）是唯一真相，
 * 語音 transcript 遞到這裡用同一套提煉（同 prompt、同 resolved 機制、同去重）。
 * agent 端打不通時 fallback Python 本地版（記憶不能丟），v17 起使用；
 * v17 升 DEFAULT 後 Python extract_and_save_memories 即可退役。
 *
 * 鑑權：x-worker-secret。架構：docs/memory-panorama-voice-integration.md
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { extractAndSaveMemories } from '@/lib/memory';
import { COL, type CharacterDoc } from '@/lib/collections';
import { verifyWorkerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
// 60s：Haiku 提煉走 bridge，agent 端 50s timeout 先斷、這裡兜底
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyWorkerSecret(req.headers.get('x-worker-secret'), process.env.WORKER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized', from: 'extract-memories' }, { status: 401 });
  }
  const body = await req.json().catch(() => null) as {
    userId?: string; characterId?: string; charName?: string;
    transcript?: Array<{ role: string; content: string }>;
  } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  if (!userId || !characterId || !Array.isArray(body?.transcript) || body!.transcript!.length < 2) {
    return NextResponse.json({ error: 'userId / characterId / transcript(≥2) 必填' }, { status: 400 });
  }

  const db = getFirestore();
  let charName = body?.charName?.trim() || '';
  if (!charName) {
    const c = await db.collection(COL.characters).doc(characterId).get();
    charName = c.exists ? String((c.data() as CharacterDoc).name || '角色') : '角色';
  }

  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 45_000 });
  await extractAndSaveMemories(db, userId, characterId, charName, body!.transcript!, client);

  return NextResponse.json({ ok: true });
}
