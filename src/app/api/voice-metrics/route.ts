/**
 * POST /api/voice-metrics — 語音體驗量測回報（前端量，零碰 agent）
 *
 * 首音延遲的真相在瀏覽器端：用戶按下撥號到「真的聽到角色出聲」（ActiveSpeakersChanged，
 * 不是 TrackSubscribed——音軌接上不代表開口）。這正是負載實測找到的真短板
 * （爆發建線首回合 27s），儀表化後 /admin/monitor 天天看得到。
 *
 * 寫入 voice_sessions/{roomName}（merge）。首音每通一次（通話中）；
 * 回合延遲 turnLatenciesMs 每通一次（掛斷 beacon，整通陣列）——GPT Voice 對照組同一把尺。
 * 安全：userId 取自 session cookie；只准寫自己的 session doc（ownership 檢查）。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';

export const runtime = 'nodejs';

const MAX_SANE_MS = 10 * 60_000;  // 超過 10 分鐘的「延遲」是壞資料不是慢

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null) as { roomName?: string; connectMs?: number; firstAudioMs?: number; turnLatenciesMs?: number[] } | null;
  const roomName = body?.roomName?.trim() || '';
  const connectMs = Number(body?.connectMs);
  const firstAudioMs = Number(body?.firstAudioMs);
  // 回合延遲（掛斷時整通一次）：逐值驗證、上限 200 筆——量測資料不信任前端
  const turns = (Array.isArray(body?.turnLatenciesMs) ? body!.turnLatenciesMs! : [])
    .filter(v => Number.isFinite(v) && v > 0 && v <= MAX_SANE_MS)
    .map(v => Math.round(v))
    .slice(0, 200);
  if (!roomName.startsWith('ailivex-')) return NextResponse.json({ error: 'bad roomName' }, { status: 400 });
  const hasFirstAudio = Number.isFinite(firstAudioMs) && firstAudioMs > 0 && firstAudioMs <= MAX_SANE_MS;
  if (!hasFirstAudio && !turns.length) {
    return NextResponse.json({ error: 'no valid metrics' }, { status: 400 });
  }

  const ref = getFirestore().collection('voice_sessions').doc(roomName);
  const snap = await ref.get();
  // doc 不在（token 開盤寫入失落）→ 200 no-op，量測不擋業務也不製造孤兒 doc
  if (!snap.exists) return NextResponse.json({ ok: true, note: 'session doc missing' });
  if (snap.data()?.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  await ref.set({
    ...(hasFirstAudio ? { firstAudioMs: Math.round(firstAudioMs) } : {}),
    ...(Number.isFinite(connectMs) && connectMs > 0 && connectMs <= MAX_SANE_MS ? { connectMs: Math.round(connectMs) } : {}),
    ...(turns.length ? { turnLatenciesMs: turns, turnCount: turns.length } : {}),
  }, { merge: true });
  return NextResponse.json({ ok: true });
}
