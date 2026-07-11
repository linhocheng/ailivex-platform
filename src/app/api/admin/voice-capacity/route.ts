/**
 * 語音容量變速箱（admin）
 * GET  → 檔位狀態（desiredMin / 活動檔 / 現役房間水位 / Cloud Run 真值 min,max）
 * POST → { action:'event', min, hours } 進活動檔（限時鎖高，到期 cron 自動回）
 *        { action:'standby' }           手動退回待命 min=1
 */
import { NextResponse } from 'next/server';
import { readVoicePowerFlag } from '@/lib/voice-power';
import {
  readCapacityState, countActiveRooms, readCloudRunScaling,
  enterEventMode, exitEventMode, SAFE_ROOMS_PER_INSTANCE,
} from '@/lib/voice-capacity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [state, rooms, scaling, flag] = await Promise.all([
      readCapacityState(), countActiveRooms(), readCloudRunScaling(), readVoicePowerFlag(),
    ]);
    const eventActive = !!(state.eventMode && Date.parse(state.eventMode.until) > Date.now());
    const effectiveMin = Math.max(state.desiredMin, scaling?.min ?? 0);
    return NextResponse.json({
      powerOn: flag.on,
      gear: !flag.on ? 'off' : eventActive ? 'event' : 'standby',
      desiredMin: state.desiredMin,
      cloudRunMin: scaling?.min ?? null,   // 真值（驗證看這個，不看 desiredMin）
      cloudRunMax: scaling?.max ?? null,
      eventMode: eventActive ? state.eventMode : null,
      rooms: rooms,
      capacity: effectiveMin * SAFE_ROOMS_PER_INSTANCE,
      perInstance: SAFE_ROOMS_PER_INSTANCE,
      lowWaterSince: state.lowWaterSince ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; min?: number; hours?: number };
    if (body.action === 'event') {
      const min = Number(body.min) || 3;
      const hours = Number(body.hours) || 2;
      await enterEventMode(min, hours);
      return NextResponse.json({ ok: true, gear: 'event', min, hours });
    }
    if (body.action === 'standby') {
      await exitEventMode();
      return NextResponse.json({ ok: true, gear: 'standby' });
    }
    return NextResponse.json({ error: '需要 { action: "event"|"standby" }' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
