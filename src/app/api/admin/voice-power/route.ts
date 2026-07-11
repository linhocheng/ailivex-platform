/**
 * 即時語音電源開關（admin）
 * GET  → 功能旗標（真相）＋ Cloud Run min-instances（錢）＋ 自動關機資訊
 * PUT  → { on: boolean } 兩層一起切（旗標＋常駐），共用邏輯在 lib/voice-power.ts
 */
import { NextResponse } from 'next/server';
import { DEFAULT_VOICE_VERSION } from '@/lib/collections';
import {
  readVoicePowerFlag, setVoicePower, cloudRunServiceUrl, cloudRunAccessToken,
  AUTO_OFF_HOURS_DEFAULT,
} from '@/lib/voice-power';

export async function GET() {
  try {
    const [flag, token] = await Promise.all([readVoicePowerFlag(), cloudRunAccessToken()]);
    const res = await fetch(cloudRunServiceUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `讀取失敗 (${res.status}): ${err.slice(0, 200)}` }, { status: 502 });
    }
    const svc = await res.json();
    return NextResponse.json({
      version: DEFAULT_VOICE_VERSION,
      on: flag.on,
      minInstances: svc?.template?.scaling?.minInstanceCount ?? 0,
      reconciling: !!svc.reconciling,
      autoOffHours: flag.autoOffHours ?? AUTO_OFF_HOURS_DEFAULT,
      lastCallAt: flag.lastCallAt || null,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.on !== 'boolean') {
      return NextResponse.json({ error: '需要 { on: true|false }' }, { status: 400 });
    }
    await setVoicePower(body.on, 'admin');
    // 開機時重置變速箱到待命底檔（desiredMin=1、清活動檔）——power cycle 後不留上次的高檔位
    if (body.on) {
      const { resetCapacityOnPowerOn } = await import('@/lib/voice-capacity');
      await resetCapacityOnPowerOn().catch(() => {});
    }
    return NextResponse.json({ ok: true, on: body.on });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
