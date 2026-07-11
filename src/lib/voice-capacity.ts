/**
 * voice-capacity — 語音容量三段變速箱＋自動水位調節器
 *
 * 容量物理（2026-07-11 負載實測）：單台穩態 6 路、保守閘 5 路/台；
 * 加機器要在劣化「之前」——升檔觸發點釘在發 token 的瞬間（領先指標，新台在通話建立前開始暖）。
 *
 * 三檔：
 *   關機   voicePower off + min=0（既有 voice-power.ts 管，本模組不碰）
 *   待命   min 在 1..max 之間由調節器自動調（本模組核心）
 *   活動   限時鎖高 min（eventMode，到期由 cron 自動降回待命——「自動回」是關鍵，不然又是殭屍燒錢機）
 *
 * 調節規則（升快降慢，避免抖動）：
 *   升檔：發 token 時 (現役房間+1) ≥ 目前容量×0.7 → desiredMin+1（Firestore transaction 防並發雙升）
 *   降檔：cron（30 分一輪）房間 < 目前容量×0.4 持續 ≥60 分 → desiredMin−1，floor 1
 *   上限：讀 Cloud Run 真值 maxInstanceCount（成本保險絲，調節器永不越過）
 *
 * 天條對齊：
 *   - cloudbuild-v18.yaml 不寫 min-instances（deploy 保留線上現值）→ 調節器的決定不會被部署洗掉
 *   - 真相=config/voiceCapacity doc + Cloud Run PATCH；驗「有沒有生效」看 Cloud Run API 回讀，不看本 doc
 */
import { RoomServiceClient } from 'livekit-server-sdk';
import { getFirestore } from '@/lib/firebase-admin';
import { cloudRunServiceUrl, cloudRunAccessToken, readVoicePowerFlag } from '@/lib/voice-power';
import { recordOpsEvent } from '@/lib/ops-event';

export const SAFE_ROOMS_PER_INSTANCE = 5;   // 併發閘保守值（實測穩態 6，留一路餘裕）
const SCALE_UP_AT = 0.7;                     // 水位 ≥70% 預熱下一台
const SCALE_DOWN_AT = 0.4;                   // 水位 <40% 進入降檔觀察
const SCALE_DOWN_HOLD_MS = 60 * 60_000;      // 低水位持續 60 分鐘才真降（升快降慢）

const CAPACITY_DOC = 'voiceCapacity';

export interface VoiceCapacityState {
  desiredMin: number;                        // 調節器目前決定的 min（1..max）
  eventMode?: { min: number; until: string } | null;  // 活動檔：限時鎖高
  lowWaterSince?: string | null;             // 低水位起算點（降檔觀察窗）
  updatedAt?: string;
  updatedBy?: string;                        // 'regulator-up' | 'regulator-down' | 'event' | 'power-on' | 'admin'
}

export async function readCapacityState(): Promise<VoiceCapacityState> {
  const snap = await getFirestore().collection('config').doc(CAPACITY_DOC).get();
  if (!snap.exists) return { desiredMin: 1 };
  const d = snap.data() as VoiceCapacityState;
  return { ...d, desiredMin: Math.max(1, d.desiredMin || 1) };
}

/** 現役 ailivex 房間數（LiveKit 現場，不是鏡子）。讀不到回 null——null 時調節器一律不動作。 */
export async function countActiveRooms(): Promise<number | null> {
  const url = (process.env.LIVEKIT_URL || '').replace(/^wss/, 'https');
  const key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) return null;
  try {
    const rooms = await new RoomServiceClient(url, key, secret).listRooms();
    return rooms.filter(r => r.name.startsWith('ailivex-') && r.numParticipants > 0).length;
  } catch {
    return null;
  }
}

/** 讀 Cloud Run 真值（min 現值 + max 上限）。 */
export async function readCloudRunScaling(): Promise<{ min: number; max: number } | null> {
  try {
    const token = await cloudRunAccessToken();
    const res = await fetch(cloudRunServiceUrl(), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) return null;
    const svc = await res.json() as { template?: { scaling?: { minInstanceCount?: number; maxInstanceCount?: number } } };
    return {
      min: svc.template?.scaling?.minInstanceCount ?? 0,
      max: svc.template?.scaling?.maxInstanceCount ?? 3,
    };
  } catch {
    return null;
  }
}

async function patchMinInstances(min: number): Promise<void> {
  const token = await cloudRunAccessToken();
  const res = await fetch(`${cloudRunServiceUrl()}?updateMask=template.scaling.minInstanceCount`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: { scaling: { minInstanceCount: min } } }),
  });
  if (!res.ok) throw new Error(`Cloud Run PATCH min=${min} 失敗 (${res.status}): ${(await res.text()).slice(0, 160)}`);
}

/** transaction 內決定新 desiredMin（防兩通 token 同時觸發雙升），回傳需要 PATCH 的值或 null。 */
async function transitionDesiredMin(
  compute: (cur: VoiceCapacityState) => { next: number; patch: Partial<VoiceCapacityState> } | null,
  updatedBy: string,
): Promise<number | null> {
  const db = getFirestore();
  const ref = db.collection('config').doc(CAPACITY_DOC);
  return await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur: VoiceCapacityState = snap.exists ? (snap.data() as VoiceCapacityState) : { desiredMin: 1 };
    cur.desiredMin = Math.max(1, cur.desiredMin || 1);
    const result = compute(cur);
    if (!result) return null;
    tx.set(ref, {
      ...result.patch,
      desiredMin: result.next,
      updatedAt: new Date().toISOString(),
      updatedBy,
    }, { merge: true });
    return result.next;
  });
}

/**
 * 升檔檢查——token route 發 token 後（after() 內）呼叫。
 * (現役房間+1 含這通新的) ≥ 容量×0.7 → min+1 預熱。活動檔期間不動（人已鎖高）。
 */
export async function maybeScaleUp(): Promise<void> {
  try {
    const flag = await readVoicePowerFlag();
    if (!flag.on) return;
    const [rooms, scaling] = await Promise.all([countActiveRooms(), readCloudRunScaling()]);
    if (rooms == null || !scaling) return;   // 讀不到現場就不動作——寧可不升，不瞎升

    const next = await transitionDesiredMin(cur => {
      if (cur.eventMode && Date.parse(cur.eventMode.until) > Date.now()) return null; // 活動檔鎖定中
      const capacity = Math.max(cur.desiredMin, scaling.min, 1) * SAFE_ROOMS_PER_INSTANCE;
      if ((rooms + 1) < capacity * SCALE_UP_AT) return null;
      const target = Math.min(Math.max(cur.desiredMin, scaling.min) + 1, scaling.max);
      if (target <= Math.max(cur.desiredMin, scaling.min)) return null; // 已到成本保險絲
      return { next: target, patch: { lowWaterSince: null } };
    }, 'regulator-up');

    if (next != null) {
      await patchMinInstances(next);
      recordOpsEvent({ kind: 'provider_call', status: 'ok', provider: 'capacity-regulator', meta: { action: 'scale-up', min: next, rooms } });
    }
  } catch (e) {
    // 調節器失敗不影響通話——留痕即可
    recordOpsEvent({ kind: 'provider_call', status: 'fail', provider: 'capacity-regulator', error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 降檔＋活動檔到期——voice-auto-off cron（30 分一輪）呼叫。
 * 回傳動作描述（cron response 用）。電源關閉時不動作（min 已被 power-off 歸 0）。
 */
export async function regulateCapacity(): Promise<string> {
  const flag = await readVoicePowerFlag();
  if (!flag.on) return 'power-off，跳過';
  const [rooms, scaling] = await Promise.all([countActiveRooms(), readCloudRunScaling()]);
  if (!scaling) return 'Cloud Run 讀取失敗，跳過';

  const state = await readCapacityState();
  const nowIso = new Date().toISOString();

  // 活動檔到期 → 自動降回待命（不自動回就是殭屍燒錢機）
  if (state.eventMode) {
    if (Date.parse(state.eventMode.until) <= Date.now()) {
      await getFirestore().collection('config').doc(CAPACITY_DOC).set(
        { eventMode: null, desiredMin: 1, lowWaterSince: null, updatedAt: nowIso, updatedBy: 'event-expire' }, { merge: true });
      await patchMinInstances(1);
      recordOpsEvent({ kind: 'provider_call', status: 'ok', provider: 'capacity-regulator', meta: { action: 'event-expire', min: 1 } });
      return `活動檔到期，回待命 min=1`;
    }
    return `活動檔鎖定中（min=${state.eventMode.min}，至 ${state.eventMode.until}）`;
  }

  if (rooms == null) return 'LiveKit 讀取失敗，跳過';

  const currentMin = Math.max(state.desiredMin, scaling.min, 1);
  if (currentMin <= 1) return `已在底檔 min=1（房間 ${rooms}）`;

  const capacity = currentMin * SAFE_ROOMS_PER_INSTANCE;
  const lowWater = rooms < capacity * SCALE_DOWN_AT;

  if (!lowWater) {
    if (state.lowWaterSince) {
      await getFirestore().collection('config').doc(CAPACITY_DOC).set(
        { lowWaterSince: null, updatedAt: nowIso, updatedBy: 'regulator-down' }, { merge: true });
    }
    return `水位正常（${rooms}/${capacity}），維持 min=${currentMin}`;
  }
  if (!state.lowWaterSince) {
    await getFirestore().collection('config').doc(CAPACITY_DOC).set(
      { lowWaterSince: nowIso, updatedAt: nowIso, updatedBy: 'regulator-down' }, { merge: true });
    return `低水位起算（${rooms}/${capacity}），觀察 60 分`;
  }
  if (Date.now() - Date.parse(state.lowWaterSince) < SCALE_DOWN_HOLD_MS) {
    return `低水位觀察中（起算 ${state.lowWaterSince}）`;
  }

  const next = Math.max(1, currentMin - 1);
  await getFirestore().collection('config').doc(CAPACITY_DOC).set(
    { desiredMin: next, lowWaterSince: null, updatedAt: nowIso, updatedBy: 'regulator-down' }, { merge: true });
  await patchMinInstances(next);
  recordOpsEvent({ kind: 'provider_call', status: 'ok', provider: 'capacity-regulator', meta: { action: 'scale-down', min: next, rooms } });
  return `降檔 min=${currentMin}→${next}（房間 ${rooms}）`;
}

/** 進活動檔：鎖高 min、限時、到期 cron 自動回。 */
export async function enterEventMode(min: number, hours: number): Promise<void> {
  const scaling = await readCloudRunScaling();
  const cap = scaling?.max ?? 3;
  const target = Math.min(Math.max(1, Math.round(min)), cap);
  const until = new Date(Date.now() + Math.min(24, Math.max(0.5, hours)) * 3600_000).toISOString();
  await getFirestore().collection('config').doc(CAPACITY_DOC).set({
    eventMode: { min: target, until },
    desiredMin: target,
    lowWaterSince: null,
    updatedAt: new Date().toISOString(),
    updatedBy: 'event',
  }, { merge: true });
  await patchMinInstances(target);
  recordOpsEvent({ kind: 'provider_call', status: 'ok', provider: 'capacity-regulator', meta: { action: 'event-enter', min: target, until } });
}

/** 手動退活動檔，回待命 min=1。 */
export async function exitEventMode(): Promise<void> {
  await getFirestore().collection('config').doc(CAPACITY_DOC).set({
    eventMode: null, desiredMin: 1, lowWaterSince: null,
    updatedAt: new Date().toISOString(), updatedBy: 'admin',
  }, { merge: true });
  await patchMinInstances(1);
  recordOpsEvent({ kind: 'provider_call', status: 'ok', provider: 'capacity-regulator', meta: { action: 'event-exit', min: 1 } });
}

/** power-on 時重置調節器狀態（voice-power.setVoicePower 呼叫）。 */
export async function resetCapacityOnPowerOn(): Promise<void> {
  await getFirestore().collection('config').doc(CAPACITY_DOC).set({
    desiredMin: 1, eventMode: null, lowWaterSince: null,
    updatedAt: new Date().toISOString(), updatedBy: 'power-on',
  }, { merge: true });
}
