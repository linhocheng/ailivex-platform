/**
 * POST /api/agent/diary-write — 語音掛斷後 agent 遞 transcript，日記在這裡寫（第 3.5 期，2026-07-08）
 *
 * 讀寫分家鐵律：日記的 LLM 生成／解析／裁剪只存在 TS（lib/diary.ts），
 * Python 只遞稿。writeDiaryEntry 內建 canary（DIARY_CANARY_USERS）與失敗靜默。
 *
 * 鑑權：x-worker-secret。架構全文：docs/memory-panorama-voice-integration.md
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { writeDiaryEntry, diaryEnabled } from '@/lib/diary';
import { COL, type CharacterDoc } from '@/lib/collections';
import { verifyWorkerSecret } from '@/lib/clean-env';

export const runtime = 'nodejs';
// 60s：Sonnet 寫日記走 bridge（暖 ~10-30s），agent 端 45s timeout 先斷、這裡兜底
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyWorkerSecret(req.headers.get('x-worker-secret'), process.env.WORKER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized', from: 'diary-write' }, { status: 401 });
  }
  const body = await req.json().catch(() => null) as {
    userId?: string; characterId?: string; charName?: string;
    transcript?: Array<{ role: string; content: string }>;
  } | null;
  const userId = body?.userId?.trim();
  const characterId = body?.characterId?.trim();
  if (!userId || !characterId || !Array.isArray(body?.transcript)) {
    return NextResponse.json({ error: 'userId / characterId / transcript 必填' }, { status: 400 });
  }
  if (!diaryEnabled(userId)) {
    return NextResponse.json({ ok: true, skipped: 'canary' }); // canary 外靜默通過，agent 端不用分支
  }

  const db = getFirestore();
  // soul 供日記語氣；charName agent 有帶就用，沒帶讀 doc
  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  const char = charSnap.exists ? (charSnap.data() as CharacterDoc) : null;
  const charName = body?.charName?.trim() || char?.name || '角色';
  const soul = char?.soul || '';

  // 語音 transcript 的 user 名稱 agent 沒帶——日記 prompt 用「他」的第三人稱即可，userName 給通稱
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 40_000 });
  await writeDiaryEntry(db, userId, characterId, charName, soul, '他', body!.transcript!, client, 'voice');

  return NextResponse.json({ ok: true });
}
