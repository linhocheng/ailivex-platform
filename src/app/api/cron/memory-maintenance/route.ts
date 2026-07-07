/**
 * GET /api/cron/memory-maintenance — 記憶新陳代謝（Vercel Cron 每日呼叫，19:00 UTC = 台北 03:00，排鞏固之後）
 *
 * 之前 tier 晉升/歸檔只有 admin 後台手動按鈕（實質半癱）。這裡自動化：
 *   fresh → core    : hitCount >= 3
 *   fresh → archive : 逾 30×(1+w) 天且 hitCount == 0
 *   core  → archive : 逾 90×(1+w) 天未命中
 * w = emotionalWeight（0~1，type＋importance 確定性推導）——情緒重的記憶衰減慢，
 * 像人：大哭大笑的日子活得比路過的事實久（第三期遺忘曲線）。
 * 加上 stale 掃描（question 60d / emotion 90×(1+w)d → status=stale）。
 *
 * 之後跑老情節模糊化（gist 化，GIST_CANARY_USERS 閘）：archive 層的長情節
 * LLM 寫大意、程式蓋 content、原文留 rawContent。?dryRun=1 只回計畫不寫（只影響 gist，
 * tier 代謝是既有已驗證路徑照常跑）。
 *
 * 鑑權：Vercel Cron 帶 Authorization: Bearer ${CRON_SECRET}；本機/手動可帶同值測試。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyBearerSecret } from '@/lib/clean-env';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { emotionalWeightOf, effectiveDays, runGistPass } from '@/lib/forgetting';

export const runtime = 'nodejs';
// 300：gist 化多一次 bridge call（冷 34s），60s 太緊
export const maxDuration = 300;

const FRESH_TO_CORE_HITS = 3;
const FRESH_STALE_DAYS = 30;
const CORE_STALE_DAYS = 90;
const QUESTION_STALE_DAYS = 60;
const EMOTION_STALE_DAYS = 90;

export async function GET(req: Request) {
  if (!verifyBearerSecret(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1';
  const db = getFirestore();
  const now = Date.now();
  const questionCutoff = now - QUESTION_STALE_DAYS * 86400_000;

  const snap = await db.collection(COL.memories)
    .where('tier', 'in', ['fresh', 'core'])
    .limit(1000)
    .get();

  let promoted = 0, archived = 0, staled = 0;
  const batch = db.batch();

  for (const doc of snap.docs) {
    const m = doc.data();
    const createdMs = (m.createdAt as Timestamp)?.toMillis?.() ?? 0;
    const lastHitMs = m.lastHitAt ? ((m.lastHitAt as Timestamp)?.toMillis?.() ?? 0) : 0;
    const status = m.status ?? 'active';
    const w = emotionalWeightOf({ type: m.type, importance: m.importance, emotionTag: m.emotionTag });

    // stale：懸而未決太久（question 不看情緒——懸著就是懸著）/ 情緒過期（重的活得久）
    if (status === 'active') {
      if (m.type === 'question' && createdMs && createdMs < questionCutoff) {
        batch.update(doc.ref, { status: 'stale' }); staled++; continue;
      }
      if (m.type === 'emotion' && createdMs
          && createdMs < now - effectiveDays(EMOTION_STALE_DAYS, w) * 86400_000) {
        batch.update(doc.ref, { status: 'stale' }); staled++; continue;
      }
    }

    // tier 新陳代謝（遺忘曲線：門檻 × (1+w)）
    if (m.tier === 'fresh') {
      if ((m.hitCount ?? 0) >= FRESH_TO_CORE_HITS) {
        batch.update(doc.ref, { tier: 'core' }); promoted++;
      } else if (createdMs && createdMs < now - effectiveDays(FRESH_STALE_DAYS, w) * 86400_000
                 && (m.hitCount ?? 0) === 0) {
        batch.update(doc.ref, { tier: 'archive' }); archived++;
      }
    } else if (m.tier === 'core') {
      const ref = lastHitMs || createdMs;
      if (ref && ref < now - effectiveDays(CORE_STALE_DAYS, w) * 86400_000) {
        batch.update(doc.ref, { tier: 'archive' }); archived++;
      }
    }
  }

  await batch.commit();

  // 老情節模糊化（canary 閘在 lib 內；未設 GIST_CANARY_USERS = 整段 no-op）
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 120_000 });
  const gist = await runGistPass(db, client, { dryRun });

  console.log(`[memory-maintenance] promoted=${promoted} archived=${archived} staled=${staled} scanned=${snap.size} gist=${JSON.stringify({ ...gist, detail: undefined })}`);
  return NextResponse.json({ scanned: snap.size, promoted, archived, staled, gist });
}
