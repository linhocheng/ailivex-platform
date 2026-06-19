/**
 * Anthropic via bridge — 把 Anthropic SDK call 轉發到 zhu-bridge（claude CLI Max OAuth）
 *
 * 目的：把 LLM call 從 per-token API key billing 切到 Claude Max 月費。
 * Bridge 失敗一律 throw，不 fallback SDK（避免雙燒）。
 */
import Anthropic from '@anthropic-ai/sdk';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

const DEFAULT_BRIDGE_TIMEOUT_MS = 280_000;

export class AnthropicBridge {
  public messages: {
    create: (args: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };

  constructor(bridgeUrl: string, secret: string, bridgeTimeoutMs?: number) {
    const url = bridgeUrl.replace(/\/$/, '');
    const timeoutMs = bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    this.messages = {
      create: async (args) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${secret}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: args.model,
              max_tokens: args.max_tokens,
              system: args.system,
              messages: args.messages,
            }),
            signal: ctrl.signal,
          });
          if (!r.ok) {
            const body = await r.text().catch(() => '');
            throw new Error(`bridge ${r.status}: ${body.slice(0, 200)}`);
          }
          return (await r.json()) as Anthropic.Message;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
}

/**
 * 依環境變數決定回 bridge client 還是原本 SDK。
 * BRIDGE_ENABLED=true + BRIDGE_URL + BRIDGE_SECRET 任一缺 → 回退 SDK。
 */
export function getAnthropicClient(
  apiKey: string,
  opts?: { bridgeTimeoutMs?: number },
): Anthropic | AnthropicBridge {
  const enabled = process.env.BRIDGE_ENABLED === 'true';
  const url = cleanUrl(process.env.BRIDGE_URL);
  const secret = cleanSecret(process.env.BRIDGE_SECRET);
  if (enabled && url && secret) {
    return new AnthropicBridge(url, secret, opts?.bridgeTimeoutMs);
  }
  return new Anthropic({ apiKey });
}
