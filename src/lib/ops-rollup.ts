/**
 * ops-rollup — 監控時間軸（每小時一筆聚合快照，collection `ops_rollups`）
 *
 * 為什麼存在：
 *  1. 趨勢——快照不是趨勢。rollup 才回答得了「成功率在惡化嗎」「水位這週爬多快」。
 *  2. 成本——監控頁的原始掃描永遠鎖在 48h 內，寬時間窗（7天/30天）改加總 rollup，
 *     讀量不再隨資料量線性長大。
 *
 * 視窗設計（兩個窗，刻意錯開）：
 *  - 事件窗 [T-1h, T)：ops_events / zhu_vitals_cost 是不可變史實，出爐即定案。
 *  - 任務窗 [T-2h, T-1h)：tasks/jobs/voice_sessions 建立後要時間跑完，
 *    延後一小時快照讓狀態沉澱（podcast 最長 70 分仍可能凍成 running——
 *    寬窗加總可接受這誤差；歸屬時刻差一小時對趨勢無感）。
 *  - sample：rollup 當下的現場抽樣（LiveKit 房間、Cloud Run min 台數）——sparkline 的點。
 *
 * docId = UTC 小時鍵（YYYY-MM-DDTHH）→ 天然冪等，cron 重跑同一小時只是覆寫同一筆。
 */
import { getFirestore } from '@/lib/firebase-admin';
import { COL } from '@/lib/collections';
import { countActiveRooms, readCloudRunScaling } from '@/lib/voice-capacity';

const TTL_DAYS = 400;

/** 任務型別 → 漏斗顯示名。monitor route 與 rollup 共用這一份（防禦釘收斂點）。 */
export const TASK_TYPE_LABEL: Record<string, string> = {
  image: '圖片生成', audio: '音訊生成', video: '影片生成', podcast: 'Podcast',
  script_draft: '腳本草稿', story_draft: '故事草稿',
};

export interface RollupFailure {
  at: number; feature: string; userId: string; characterId: string; error: string; kind: 'fail' | 'stuck';
}

export interface OpsRollup {
  hourKey: string;
  at: Date | { toMillis(): number };
  dialogue: { ok: number; fail: number };
  sideEffectErrors: number;
  providers: Record<string, { calls: number; fails: number; lastOkAt: number | null }>;
  llm: Record<string, { calls: number; cost: number }>;  // anthropic / bridge
  taskFunnel: Record<string, { ok: number; fail: number; stuck: number; running: number }>;
  voice: { started: number; closed: number; abandoned: number; latencyCount?: number; latencyAvgMs?: number; latencyMaxMs?: number };
  sample: { rooms: number | null; minInstances: number | null; openSessions: number };
  failures: RollupFailure[];
}

function toMs(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number };
  return typeof t.toMillis === 'function' ? t.toMillis() : 0;
}

/** 計算並寫入上一個整點小時的 rollup。回傳 hourKey 與摘要（cron 回應用）。 */
export async function computeHourlyRollup(): Promise<{ hourKey: string; dialogue: number; tasks: number }> {
  const db = getFirestore();
  const now = Date.now();
  const hourStart = new Date(Math.floor(now / 3600_000) * 3600_000 - 3600_000);
  const hourEnd = new Date(hourStart.getTime() + 3600_000);
  const taskStart = new Date(hourStart.getTime() - 3600_000);
  const hourKey = hourStart.toISOString().slice(0, 13);

  const [eventsSnap, costSnap, tasksSnap, jobsSnap, sessionsSnap, openSnap, rooms, scaling] = await Promise.all([
    db.collection('ops_events').where('at', '>=', hourStart).where('at', '<', hourEnd).get(),
    db.collection('zhu_vitals_cost').where('timestamp', '>=', hourStart).where('timestamp', '<', hourEnd).get(),
    db.collection(COL.tasks).where('createdAt', '>=', taskStart).where('createdAt', '<', hourStart).get(),
    db.collection(COL.jobs).where('createdAt', '>=', taskStart).where('createdAt', '<', hourStart).get(),
    db.collection('voice_sessions').where('startedAt', '>=', taskStart).where('startedAt', '<', hourStart).get(),
    db.collection('voice_sessions').where('status', '==', 'open').get(),
    countActiveRooms(),
    readCloudRunScaling().catch(() => null),
  ]);

  const dialogue = { ok: 0, fail: 0 };
  let sideEffectErrors = 0;
  const providers: OpsRollup['providers'] = {};
  const failures: RollupFailure[] = [];
  const pushFailure = (f: RollupFailure) => { if (failures.length < 5) failures.push(f); };

  for (const d of eventsSnap.docs) {
    const e = d.data() as { kind?: string; status?: string; provider?: string; sideEffect?: string; userId?: string; characterId?: string; error?: string; at?: unknown };
    if (e.kind === 'dialogue') {
      if (e.status === 'ok') dialogue.ok++;
      else {
        dialogue.fail++;
        pushFailure({ at: toMs(e.at), feature: '文字對話', userId: e.userId || '', characterId: e.characterId || '', error: e.error || '', kind: 'fail' });
      }
    } else if (e.kind === 'side_effect_error') {
      sideEffectErrors++;
      pushFailure({ at: toMs(e.at), feature: `副作用·${e.sideEffect || '?'}`, userId: e.userId || '', characterId: e.characterId || '', error: e.error || '', kind: 'fail' });
    } else if (e.kind === 'provider_call' && e.provider) {
      const p = providers[e.provider] = providers[e.provider] || { calls: 0, fails: 0, lastOkAt: null };
      p.calls++;
      if (e.status === 'ok') p.lastOkAt = Math.max(p.lastOkAt || 0, toMs(e.at));
      else p.fails++;
    }
  }

  const llm: OpsRollup['llm'] = {};
  for (const d of costSnap.docs) {
    const c = d.data() as { project?: string; route?: string; cost_usd_est?: number };
    if (c.project !== 'ailivex-platform') continue;
    const key = c.route === 'bridge' ? 'bridge' : 'anthropic';
    llm[key] = llm[key] || { calls: 0, cost: 0 };
    llm[key].calls++;
    llm[key].cost += c.cost_usd_est || 0;
  }

  const taskFunnel: OpsRollup['taskFunnel'] = {};
  const bump = (f: string, k: 'ok' | 'fail' | 'stuck' | 'running') => {
    taskFunnel[f] = taskFunnel[f] || { ok: 0, fail: 0, stuck: 0, running: 0 };
    taskFunnel[f][k]++;
  };
  for (const d of tasksSnap.docs) {
    const t = d.data() as { type?: string; status?: string; error?: string; userId?: string; characterId?: string; createdAt?: unknown };
    const feature = TASK_TYPE_LABEL[t.type || ''] || `任務(${t.type})`;
    if (t.status === 'done' || t.status === 'ready' || t.status === 'scripted') bump(feature, 'ok');
    else if (t.status === 'failed') {
      bump(feature, 'fail');
      pushFailure({ at: toMs(t.createdAt), feature, userId: t.userId || '', characterId: t.characterId || '', error: (t.error || '').slice(0, 300), kind: 'fail' });
    } else bump(feature, 'stuck');  // 建立已 1-2h 還沒收案 → 快照定格為卡死
  }
  for (const d of jobsSnap.docs) {
    const j = d.data() as { status?: string; error?: string; userId?: string; characterId?: string; createdAt?: unknown };
    if (j.status === 'done') bump('文件生成', 'ok');
    else if (j.status === 'failed') {
      bump('文件生成', 'fail');
      pushFailure({ at: toMs(j.createdAt), feature: '文件生成', userId: j.userId || '', characterId: j.characterId || '', error: (j.error || '').slice(0, 300), kind: 'fail' });
    } else bump('文件生成', 'stuck');
  }

  const voice: OpsRollup['voice'] = { started: sessionsSnap.size, closed: 0, abandoned: 0 };
  const latencies: number[] = [];
  for (const d of sessionsSnap.docs) {
    const s = d.data() as { status?: string; firstAudioMs?: number };
    if (s.status === 'closed') voice.closed++;
    else if (s.status === 'abandoned') voice.abandoned++;
    if (typeof s.firstAudioMs === 'number' && s.firstAudioMs > 0) latencies.push(s.firstAudioMs);
  }
  if (latencies.length) {
    voice.latencyCount = latencies.length;
    voice.latencyAvgMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    voice.latencyMaxMs = Math.max(...latencies);
  }

  const doc: OpsRollup & { expires_at: Date } = {
    hourKey,
    at: hourStart,
    dialogue, sideEffectErrors, providers, llm, taskFunnel, voice,
    sample: { rooms, minInstances: scaling?.min ?? null, openSessions: openSnap.size },
    failures,
    expires_at: new Date(now + TTL_DAYS * 86400_000),
  };
  await db.collection('ops_rollups').doc(hourKey).set(doc);
  return { hourKey, dialogue: dialogue.ok + dialogue.fail, tasks: tasksSnap.size + jobsSnap.size };
}
