/**
 * LiveKit webhook —— 錄音收帳（egress_ended）。
 *
 * 驗簽：Authorization 帶 LiveKit 簽的 JWT（payload sha256），WebhookReceiver 驗過才信。
 * middleware 已把本路徑列入 PUBLIC_PATHS（LiveKit Cloud 打進來沒有 session cookie）。
 * LiveKit Cloud 後台 Settings → Webhooks 需指向本路徑（一次性設定）。
 * 沒設 webhook 也不會斷：admin 錄音列表有 reconcile 兜底對帳。
 */
import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { egressResultFields } from '@/lib/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'LIVEKIT_* env 未設定' }, { status: 500 });
  }

  const body = await req.text();
  const auth = req.headers.get('authorization') || '';
  let event;
  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(body, auth);
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  if (event.event === 'egress_ended' && event.egressInfo?.roomName) {
    const ref = getFirestore().collection(COL.recordings).doc(event.egressInfo.roomName);
    const snap = await ref.get();
    // 只收自己開的帳（別的 egress 事件不建 doc）
    if (snap.exists) {
      await ref.update(egressResultFields(event.egressInfo) as Record<string, unknown>);
    }
  }

  return NextResponse.json({ ok: true });
}
