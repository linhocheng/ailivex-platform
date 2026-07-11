/**
 * /api/admin/monitor — 監控中台聚合查詢
 * Phase 1：純讀現成資料（tasks/jobs/documents/cost/LiveKit/Cloud Run 探測）
 * Phase 2：事件脊椎（ops_events + voice_sessions）——文字/語音漏斗、第三方呼叫結果、cron 心跳、副作用吞錯
 * Phase 2.5：時間軸＋計費錶——原始掃描鎖 48h，寬時間窗加總 ops_rollups；
 *            趨勢 series 供 sparkline；Cloud Run billable_instance_time 真值（計費錶天條）
 *
 * 一次回傳：服務燈號 / 容量水位 / 計費錶 / 在線用戶 / 趨勢 / 使用漏斗 / 失敗事件 / 第三方依賴。
 * 原則：
 *  - 燈色只從證據亮（真的打 /health、真的 listRooms），不從設定推
 *  - 沒接管道的資料誠實回 phase2 標記，前端灰燈顯示，不裝綠
 *  - 每個外部探測都有 timeout + try/catch，單點掛掉不拖垮整頁
 * 水位分母：單台 6 路（2026-07-11 負載實測：6 路穩態無劣化、CPU 66%，保守閘 5 路/台）
 */
import { NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, DEFAULT_VOICE_VERSION } from '@/lib/collections';
import { cloudRunServiceUrl, cloudRunAccessToken, readVoicePowerFlag } from '@/lib/voice-power';
import { readBillableInstanceTime } from '@/lib/cloudrun-billing';
import { TASK_TYPE_LABEL, type OpsRollup } from '@/lib/ops-rollup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOMS_PER_INSTANCE = 6;      // 實測穩態容量
const SAFE_ROOMS_PER_INSTANCE = 5; // 併發閘保守值
const STUCK_JOB_MIN = 15;
const STUCK_TASK_MIN = 30;
const STUCK_PODCAST_MIN = 70;      // podcast Cloud Run Job task-timeout 3600s + 緩衝

type Light = { key: string; name: string; status: 'green' | 'red' | 'amber' | 'gray'; why: string };

function toMs(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number };
  return typeof t.toMillis === 'function' ? t.toMillis() : 0;
}

async function probe(url: string, timeoutMs = 3500): Promise<{ ok: boolean; status: number; ms: number }> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const windowH = Math.min(720, Math.max(1, Number(new URL(req.url).searchParams.get('window') || 24)));
  const since = new Date(Date.now() - windowH * 3600_000);
  // 原始掃描永遠鎖在 48h 內；更寬的窗（7天/30天）從 ops_rollups 加總——讀量不隨資料量線性長大
  const rawWindowH = Math.min(windowH, 48);
  const rawSince = new Date(Date.now() - rawWindowH * 3600_000);
  const db = getFirestore();

  // ── 並行收料：Firestore 掃描 + 外部探測 ──
  const lkUrl = (process.env.LIVEKIT_URL || '').replace(/^wss/, 'https');
  const roomSvc = lkUrl && process.env.LIVEKIT_API_KEY
    ? new RoomServiceClient(lkUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
    : null;

  const [
    tasksSnap, jobsSnap, docsSnap, convsSnap, costSnap,
    eventsSnap, sessionsSnap, openSessionsSnap, rollupsSnap, billing,
    powerFlag, docWorker, bridge, roomsResult, runService,
  ] = await Promise.all([
    db.collection(COL.tasks).where('createdAt', '>=', rawSince).get(),
    db.collection(COL.jobs).where('createdAt', '>=', rawSince).get(),
    db.collection(COL.documents).where('createdAt', '>=', since).get(),
    db.collection(COL.conversations).where('updatedAt', '>=', new Date(Date.now() - 7 * 86400_000)).get(),
    db.collection('zhu_vitals_cost').where('timestamp', '>=', rawSince).get(),
    // Phase 2 事件脊椎：dialogue 成敗 / 第三方呼叫 / cron 心跳 / 副作用吞錯
    // 固定 48h 回看：cron 心跳需要（24h 窗會誤判每日 cron 斷線）；更舊的事件已在 rollup 裡
    db.collection('ops_events').where('at', '>=', new Date(Date.now() - 48 * 3600_000)).get(),
    // 語音 session：48h 內開的（含已關）＋所有還開著的（窗外長通話算 running；abandoned 由 cron 清掃收案）
    db.collection('voice_sessions').where('startedAt', '>=', rawSince).get(),
    db.collection('voice_sessions').where('status', '==', 'open').get(),
    // 時間軸：窗內全部 rollup（series 用全量；寬窗加總只取 rawSince 之前的小時，避免與原始掃描重複計數）
    db.collection('ops_rollups').where('at', '>=', since).orderBy('at', 'asc').get(),
    readBillableInstanceTime(windowH),
    readVoicePowerFlag().catch(() => ({ on: true } as { on: boolean; lastCallAt?: string })),
    process.env.CLOUD_RUN_DOC_WORKER_URL
      ? probe(`${process.env.CLOUD_RUN_DOC_WORKER_URL}/health`)
      : Promise.resolve(null),
    process.env.BRIDGE_URL
      ? probe(new URL(process.env.BRIDGE_URL).origin)   // 任何 HTTP 回應都算可達（bridge 只有 POST 契約）
      : Promise.resolve(null),
    roomSvc ? roomSvc.listRooms().then(r => ({ ok: true as const, rooms: r })).catch(e => ({ ok: false as const, err: String(e).slice(0, 120) })) : Promise.resolve(null),
    (async () => {
      try {
        const token = await cloudRunAccessToken();
        const res = await fetch(cloudRunServiceUrl(DEFAULT_VOICE_VERSION), {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
        });
        if (!res.ok) return { ok: false, why: `Cloud Run API ${res.status}` };
        const svc = await res.json() as {
          template?: { scaling?: { minInstanceCount?: number; maxInstanceCount?: number } };
          terminalCondition?: { type?: string; state?: string };
        };
        return {
          ok: svc.terminalCondition?.state === 'CONDITION_SUCCEEDED',
          min: svc.template?.scaling?.minInstanceCount ?? 0,
          max: svc.template?.scaling?.maxInstanceCount ?? 3,
          why: svc.terminalCondition?.state || 'unknown',
        };
      } catch (e) {
        return { ok: false, why: String(e).slice(0, 120) };
      }
    })(),
  ]);

  const now = Date.now();

  // ── 在線：語音 = LiveKit 現場；文字 = conversations.updatedAt ──
  const ailivexRooms = roomsResult?.ok
    ? roomsResult.rooms.filter(r => r.name.startsWith('ailivex-') && r.numParticipants > 0)
    : [];
  const voiceRooms = ailivexRooms.map(r => {
    const parts = r.name.split('-');   // ailivex-<charId>-<userId>-<ts>
    return {
      characterId: parts[1] || '?',
      userId: parts[2] || '?',
      participants: r.numParticipants,
      durationMin: r.creationTime ? Math.round((now / 1000 - Number(r.creationTime)) / 60) : null,
    };
  });
  const activeUserIds15m = new Set<string>();
  const activeUserIdsToday = new Set<string>();
  const activeUserIdsWeek = new Set<string>();
  for (const d of convsSnap.docs) {
    const c = d.data() as { userId?: string; updatedAt?: unknown };
    const ts = toMs(c.updatedAt);
    if (!c.userId) continue;
    activeUserIdsWeek.add(c.userId);
    if (now - ts < 15 * 60_000) activeUserIds15m.add(c.userId);
    if (now - ts < 24 * 3600_000) activeUserIdsToday.add(c.userId);
  }
  for (const r of voiceRooms) { activeUserIds15m.add(r.userId); activeUserIdsToday.add(r.userId); activeUserIdsWeek.add(r.userId); }

  // ── 漏斗 + 卡死 + 失敗事件 ──
  type Row = { at: number; feature: string; userId: string; characterId: string; error: string; kind: 'fail' | 'stuck' };
  const funnel: Record<string, { ok: number; fail: number; running: number; stuck: number }> = {};
  const bump = (f: string, k: 'ok' | 'fail' | 'running' | 'stuck') => {
    funnel[f] = funnel[f] || { ok: 0, fail: 0, running: 0, stuck: 0 };
    funnel[f][k]++;
  };
  const failures: Row[] = [];

  for (const d of tasksSnap.docs) {
    const t = d.data() as { type?: string; status?: string; error?: string; userId?: string; characterId?: string; createdAt?: unknown };
    const feature = TASK_TYPE_LABEL[t.type || ''] || `任務(${t.type})`;
    const ageMin = (now - toMs(t.createdAt)) / 60_000;
    const stuckTh = (t.type || '').startsWith('podcast') ? STUCK_PODCAST_MIN : STUCK_TASK_MIN;
    if (t.status === 'done' || t.status === 'ready' || t.status === 'scripted') bump(feature, 'ok');
    else if (t.status === 'failed') {
      bump(feature, 'fail');
      failures.push({ at: toMs(t.createdAt), feature, userId: t.userId || '', characterId: t.characterId || '', error: (t.error || '').slice(0, 300), kind: 'fail' });
    } else if ((t.status === 'running' || t.status === 'pending') && ageMin > stuckTh) {
      bump(feature, 'stuck');
      failures.push({ at: toMs(t.createdAt), feature, userId: t.userId || '', characterId: t.characterId || '', error: `無錯誤訊息 — ${t.status} 已 ${Math.round(ageMin)} 分（疑卡死）`, kind: 'stuck' });
    } else bump(feature, 'running');
  }
  for (const d of jobsSnap.docs) {
    const j = d.data() as { status?: string; error?: string; userId?: string; characterId?: string; createdAt?: unknown };
    const ageMin = (now - toMs(j.createdAt)) / 60_000;
    if (j.status === 'done') bump('文件生成', 'ok');
    else if (j.status === 'failed') {
      bump('文件生成', 'fail');
      failures.push({ at: toMs(j.createdAt), feature: '文件生成', userId: j.userId || '', characterId: j.characterId || '', error: (j.error || '').slice(0, 300), kind: 'fail' });
    } else if (ageMin > STUCK_JOB_MIN) {
      bump('文件生成', 'stuck');
      failures.push({ at: toMs(j.createdAt), feature: '文件生成', userId: j.userId || '', characterId: j.characterId || '', error: `無錯誤訊息 — ${j.status} 已 ${Math.round(ageMin)} 分（疑 worker 中斷）`, kind: 'stuck' });
    } else bump('文件生成', 'running');
  }
  // ── Phase 2：事件脊椎聚合 ──
  type Ev = { kind?: string; status?: string; provider?: string; cron?: string; sideEffect?: string; userId?: string; characterId?: string; latencyMs?: number; error?: string; at?: unknown };
  const sinceMs = since.getTime();
  const allEvents = eventsSnap.docs.map(d => d.data() as Ev);
  // cron 用全量（48h 回看），其餘 kind 照時間窗
  const events = allEvents.filter(e => e.kind === 'cron_run' || toMs(e.at) >= sinceMs);

  // 文字對話漏斗（dialogue 事件）
  for (const e of events) {
    if (e.kind !== 'dialogue') continue;
    bump('文字對話', e.status === 'ok' ? 'ok' : 'fail');
    if (e.status !== 'ok') failures.push({ at: toMs(e.at), feature: '文字對話', userId: e.userId || '', characterId: e.characterId || '', error: e.error || '', kind: 'fail' });
  }
  // 副作用吞錯（吞可以，吞之前留的痕）
  for (const e of events) {
    if (e.kind !== 'side_effect_error') continue;
    failures.push({ at: toMs(e.at), feature: `副作用·${e.sideEffect || '?'}`, userId: e.userId || '', characterId: e.characterId || '', error: e.error || '', kind: 'fail' });
  }
  // 語音 session 漏斗：closed=成功、abandoned=清掃收案的中斷、open 超過 3h=中斷（清掃前的空窗）、open 新鮮=通話中
  type Sess = { userId?: string; characterId?: string; status?: string; startedAt?: unknown; durationS?: number };
  const sessById = new Map<string, Sess>();
  for (const d of [...sessionsSnap.docs, ...openSessionsSnap.docs]) sessById.set(d.id, d.data() as Sess);
  const ABANDON_MS = 3 * 3600_000;
  for (const [id, s] of sessById) {
    if (s.status === 'closed') bump('語音通話', 'ok');
    else if (s.status === 'abandoned') {
      bump('語音通話', 'stuck');
      failures.push({ at: toMs(s.startedAt), feature: '語音通話', userId: s.userId || '', characterId: s.characterId || '', error: `voice-end 未送達（room ${id}，已由清掃收案）`, kind: 'stuck' });
    } else if (now - toMs(s.startedAt) > ABANDON_MS) {
      bump('語音通話', 'stuck');
      failures.push({ at: toMs(s.startedAt), feature: '語音通話', userId: s.userId || '', characterId: s.characterId || '', error: `session 未收盤已 ${Math.round((now - toMs(s.startedAt)) / 3600_000)} 小時（room ${id}，疑掛斷未送達）`, kind: 'stuck' });
    } else bump('語音通話', 'running');
  }
  // 第三方呼叫聚合
  const provAgg: Record<string, { calls: number; fails: number; lastOkAt: number; lastError: string | null }> = {};
  for (const e of events) {
    if (e.kind !== 'provider_call' || !e.provider) continue;
    const p = provAgg[e.provider] = provAgg[e.provider] || { calls: 0, fails: 0, lastOkAt: 0, lastError: null };
    p.calls++;
    if (e.status === 'ok') p.lastOkAt = Math.max(p.lastOkAt, toMs(e.at));
    else { p.fails++; if (toMs(e.at) >= p.lastOkAt) p.lastError = e.error || null; }
  }
  // cron 心跳：每條最後一次 ok 的時間 ＋ 最新一筆的狀態
  const cronAgg: Record<string, { lastOkAt: number; lastTs: number; lastStatus: string; lastError: string | null }> = {};
  for (const e of events) {
    if (e.kind !== 'cron_run' || !e.cron) continue;
    const c = cronAgg[e.cron] = cronAgg[e.cron] || { lastOkAt: 0, lastTs: 0, lastStatus: '', lastError: null };
    const ts = toMs(e.at);
    if (e.status === 'ok') c.lastOkAt = Math.max(c.lastOkAt, ts);
    if (ts >= c.lastTs) {
      c.lastTs = ts;
      c.lastStatus = e.status || '';
      c.lastError = e.status !== 'ok' ? (e.error || null) : null;
    }
  }

  // ── 第三方：LLM 從 cost 明細聚合（48h 內原始資料；更舊的在下方 rollup 合併補齊）──
  const llm: Record<string, { calls: number; cost: number; lastAt: number }> = {};
  for (const d of costSnap.docs) {
    const c = d.data() as { project?: string; route?: string; cost_usd_est?: number; timestamp?: unknown };
    if (c.project !== 'ailivex-platform') continue;
    const key = c.route === 'bridge' ? 'bridge' : 'anthropic';
    llm[key] = llm[key] || { calls: 0, cost: 0, lastAt: 0 };
    llm[key].calls++;
    llm[key].cost += c.cost_usd_est || 0;
    llm[key].lastAt = Math.max(llm[key].lastAt, toMs(c.timestamp));
  }

  // ── Phase 2.5：寬時間窗從 rollup 加總 ──
  // 原始掃描覆蓋 [rawSince, now]；rollup 只取整小時落在 rawSince 之前的（at ≤ rawSince−1h），
  // 兩段無縫也無重疊。series（sparkline）用窗內全量 rollup——只做顯示，不參與計數。
  const rollups = rollupsSnap.docs.map(d => d.data() as unknown as OpsRollup);
  const addN = (f: string, k: 'ok' | 'fail' | 'running' | 'stuck', n: number) => {
    if (!n) return;
    funnel[f] = funnel[f] || { ok: 0, fail: 0, running: 0, stuck: 0 };
    funnel[f][k] += n;
  };
  const sumRollups = windowH > rawWindowH
    ? rollups.filter(r => toMs(r.at) <= rawSince.getTime() - 3600_000)
    : [];
  for (const r of sumRollups) {
    addN('文字對話', 'ok', r.dialogue?.ok || 0);
    addN('文字對話', 'fail', r.dialogue?.fail || 0);
    addN('語音通話', 'ok', r.voice?.closed || 0);
    addN('語音通話', 'stuck', r.voice?.abandoned || 0);
    for (const [f, v] of Object.entries(r.taskFunnel || {})) {
      addN(f, 'ok', v.ok); addN(f, 'fail', v.fail); addN(f, 'stuck', v.stuck); addN(f, 'running', v.running);
    }
    for (const [p, v] of Object.entries(r.providers || {})) {
      const agg = provAgg[p] = provAgg[p] || { calls: 0, fails: 0, lastOkAt: 0, lastError: null };
      agg.calls += v.calls; agg.fails += v.fails;
      if (v.lastOkAt) agg.lastOkAt = Math.max(agg.lastOkAt, v.lastOkAt);
    }
    for (const [k, v] of Object.entries(r.llm || {})) {
      llm[k] = llm[k] || { calls: 0, cost: 0, lastAt: 0 };
      llm[k].calls += v.calls; llm[k].cost += v.cost;
      llm[k].lastAt = Math.max(llm[k].lastAt, toMs(r.at));
    }
    for (const f of r.failures || []) failures.push(f);
  }
  const series = rollups.map(r => ({
    h: r.hourKey,
    at: toMs(r.at),
    dialogueOk: r.dialogue?.ok || 0,
    dialogueFail: r.dialogue?.fail || 0,
    rooms: r.sample?.rooms ?? null,
    minInstances: r.sample?.minInstances ?? null,
  }));

  failures.sort((a, b) => b.at - a.at);
  const stuckTotal = Object.values(funnel).reduce((s, f) => s + f.stuck, 0);
  // Phase 2：bridge/minimax/vertex/fal/media-worker 從事件脊椎取真實呼叫結果
  const pa = (key: string) => provAgg[key] ?? { calls: 0, fails: 0, lastOkAt: 0, lastError: null };
  const providers = [
    { name: 'Anthropic 直連', use: '語音 turn-path', calls: llm.anthropic?.calls ?? 0, fails: null, lastOkAt: llm.anthropic?.lastAt ?? null, lastError: null, cost: llm.anthropic?.cost ?? null, phase2: false },
    { name: 'Bridge（Max）', use: '文字/文件/記憶', calls: pa('bridge').calls || (llm.bridge?.calls ?? 0), fails: pa('bridge').fails, lastOkAt: pa('bridge').lastOkAt || (llm.bridge?.lastAt ?? null) || null, lastError: pa('bridge').lastError, cost: 0, costNote: '月費內', phase2: false },
    { name: 'LiveKit Cloud', use: 'WebRTC 房間', calls: null, fails: roomsResult?.ok ? 0 : 1, lastOkAt: roomsResult?.ok ? now : null, lastError: roomsResult && !roomsResult.ok ? roomsResult.err : null, cost: null, costNote: '方案內', phase2: false },
    { name: 'FAL（Kling）', use: '影片生成', calls: pa('fal').calls, fails: pa('fal').fails, lastOkAt: pa('fal').lastOkAt || null, lastError: pa('fal').lastError, cost: null, phase2: false },
    { name: 'MiniMax TTS（web）', use: '語音測試/podcast', calls: pa('minimax-tts').calls, fails: pa('minimax-tts').fails, lastOkAt: pa('minimax-tts').lastOkAt || null, lastError: pa('minimax-tts').lastError, cost: null, phase2: false },
    { name: 'Vertex Embeddings', use: '記憶/知識檢索', calls: pa('vertex-embeddings').calls, fails: pa('vertex-embeddings').fails, lastOkAt: pa('vertex-embeddings').lastOkAt || null, lastError: pa('vertex-embeddings').lastError, cost: null, phase2: false },
    { name: 'media-worker', use: '圖/音派發', calls: pa('media-worker').calls, fails: pa('media-worker').fails, lastOkAt: pa('media-worker').lastOkAt || null, lastError: pa('media-worker').lastError, cost: null, phase2: false },
    // agent 內的 MiniMax/Soniox 呼叫在 Python 側，儀表化屬 Phase 3（本階段不碰 v18）
    { name: 'Soniox STT（agent）', use: '語音辨識', calls: null, fails: null, lastOkAt: null, lastError: null, cost: null, phase2: true },
  ];

  // ── 燈號 ──
  const lights: Light[] = [
    { key: 'vercel', name: 'Vercel 平臺', status: 'green', why: '本頁載入即證明' },
    runService && 'min' in runService
      ? {
          key: 'agent', name: `語音 agent ${DEFAULT_VOICE_VERSION}`,
          status: powerFlag.on ? (runService.ok && (runService.min ?? 0) >= 1 ? 'green' : 'red') : 'gray',
          why: powerFlag.on
            ? `Cloud Run ${runService.ok ? 'ready' : runService.why} · min=${runService.min} max=${runService.max}`
            : '電源開關關閉（刻意狀態）',
        }
      : { key: 'agent', name: `語音 agent ${DEFAULT_VOICE_VERSION}`, status: 'red', why: (runService as { why?: string })?.why || 'Cloud Run API 讀取失敗' },
    docWorker
      ? { key: 'docworker', name: 'doc-worker', status: docWorker.ok ? 'green' : 'red', why: docWorker.ok ? `/health ${docWorker.status} · ${docWorker.ms}ms` : `探測失敗（${docWorker.status || 'timeout'}）` }
      : { key: 'docworker', name: 'doc-worker', status: 'gray', why: 'CLOUD_RUN_DOC_WORKER_URL 未設' },
    roomsResult
      ? { key: 'livekit', name: 'LiveKit Cloud', status: roomsResult.ok ? 'green' : 'red', why: roomsResult.ok ? `listRooms 通 · ${ailivexRooms.length} 房活躍` : `listRooms 失敗: ${roomsResult.err}` }
      : { key: 'livekit', name: 'LiveKit Cloud', status: 'gray', why: 'LIVEKIT_* env 未設' },
    bridge
      ? { key: 'bridge', name: 'Bridge', status: bridge.status > 0 ? 'green' : 'red', why: bridge.status > 0 ? `可達 · ${bridge.ms}ms` : '連線失敗' }
      : { key: 'bridge', name: 'Bridge', status: 'gray', why: 'BRIDGE_URL 未設' },
    stuckTotal > 0
      ? { key: 'pipeline', name: '任務管線', status: 'amber', why: `${stuckTotal} 件卡死（running/pending 超時）` }
      : { key: 'pipeline', name: '任務管線', status: 'green', why: '無卡死任務' },
    // cron 燈：以「最後成功心跳距今」判色（memory 每日 → 26h 門檻；auto-off 每 30 分 → 40 分門檻）
    ...([
      { cron: 'memory-consolidation', label: 'cron·記憶鞏固', thresholdMin: 26 * 60 },
      { cron: 'memory-maintenance', label: 'cron·記憶維護', thresholdMin: 26 * 60 },
      { cron: 'voice-auto-off', label: 'cron·語音自動關機', thresholdMin: 40 },
      { cron: 'ops-rollup', label: 'cron·監控快照', thresholdMin: 90 },
    ] as const).map(({ cron, label, thresholdMin }): Light => {
      const c = cronAgg[cron];
      if (!c || (!c.lastOkAt && !c.lastTs)) return { key: cron, name: label, status: 'gray', why: '尚無心跳（剛接線，等下一輪排程）' };
      if (c.lastStatus !== 'ok') return { key: cron, name: label, status: 'red', why: `最新一輪失敗：${(c.lastError || '').slice(0, 80)}` };
      const ageMin = Math.round((now - c.lastOkAt) / 60_000);
      return ageMin > thresholdMin
        ? { key: cron, name: label, status: 'red', why: `逾期 — 上次成功 ${ageMin} 分鐘前（門檻 ${thresholdMin} 分）` }
        : { key: cron, name: label, status: 'green', why: `上次成功 ${ageMin} 分鐘前` };
    }),
  ];

  // ── 水位 ──
  const maxInstances = (runService && 'max' in runService ? runService.max : 3) ?? 3;
  const minInstances = (runService && 'min' in runService ? runService.min : 0) ?? 0;
  const gauges = {
    voice: {
      current: voiceRooms.length,
      ceiling: maxInstances * ROOMS_PER_INSTANCE,
      safeGate: maxInstances * SAFE_ROOMS_PER_INSTANCE,
      perInstance: ROOMS_PER_INSTANCE,
      minInstances, maxInstances,
      note: `上限 = ${ROOMS_PER_INSTANCE} 路/台 × max ${maxInstances} 台（2026-07-11 實測）`,
    },
    queue: {
      pending: Object.values(funnel).reduce((s, f) => s + f.running, 0),
      stuck: stuckTotal,
    },
  };

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    windowH,
    lights,
    gauges,
    online: {
      voiceCount: voiceRooms.length,
      voiceRooms,
      textActive15m: activeUserIds15m.size,
      todayActive: activeUserIdsToday.size,
      weekActive: activeUserIdsWeek.size,
    },
    // Phase 2：文字對話（dialogue 事件）與語音通話（voice_sessions）已接真管道
    funnel: Object.entries(funnel)
      .sort(([a], [b]) => {
        const ORDER = ['文字對話', '語音通話', '文件生成'];
        const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map(([feature, f]) => ({ feature, ...f, phase2: false })),
    failures: failures.slice(0, 20),
    providers,
    docsWindow: docsSnap.size,
    // Phase 2.5：時間軸（每小時一點，rollup cron 累積）＋ Cloud Run 計費錶真值
    series,
    billing,
  });
}
