/**
 * 費用追蹤（精簡版）—— 寫 zhu_vitals_cost 一條帶 timestamp 的明細。
 * bridge = Claude Max 月費吃到飽，cost_usd_est 只是參考用量，不是實際帳單。
 */
import { getFirestore } from '@/lib/firebase-admin';
import { randomUUID } from 'crypto';

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
};
const DEFAULT_PRICING = { input: 0.80, output: 4.00 };
const COST_TTL_DAYS = 90;

export function calcCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export async function trackCost(
  characterId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  purpose: string,
  userId?: string,
): Promise<void> {
  if (inputTokens + outputTokens === 0) return;
  try {
    const db = getFirestore();
    await db.collection('zhu_vitals_cost').add({
      call_id: randomUUID(),
      timestamp: new Date(),
      project: 'ailivex-platform',
      worker_id: `ailivex-${purpose}`,
      character_id: characterId,
      user_id: userId ?? null,
      type: 'llm',
      route: process.env.BRIDGE_ENABLED === 'true' ? 'bridge' : 'anthropic-sdk',
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd_est: calcCostUSD(model, inputTokens, outputTokens),
      purpose,
      expires_at: new Date(Date.now() + COST_TTL_DAYS * 86400 * 1000),
    });
  } catch (e) {
    console.error('[cost-tracker] write failed:', purpose, e instanceof Error ? e.message : String(e));
  }
}
