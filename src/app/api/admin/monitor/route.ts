/**
 * /api/admin/monitor — 監控中台聚合查詢（Phase 1：純讀現成資料，不動任何管道）
 *
 * 一次回傳：服務燈號 / 容量水位 / 在線用戶 / 使用漏斗 / 失敗事件 / 第三方依賴。
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
  const db = getFirestore();

  // ── 並行收料：Firestore 掃描 + 外部探測 ──
  const lkUrl = (process.env.LIVEKIT_URL || '').replace(/^wss/, 'https');
  const roomSvc = lkUrl && process.env.LIVEKIT_API_KEY
    ? new RoomServiceClient(lkUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
    : null;

  const [
    tasksSnap, jobsSnap, docsSnap, convsSnap, costSnap,
    powerFlag, docWorker, bridge, roomsResult, runService,
  ] = await Promise.all([
    db.collection(COL.tasks).where('createdAt', '>=', since).get(),
    db.collection(COL.jobs).where('createdAt', '>=', since).get(),
    db.collection(COL.documents).where('createdAt', '>=', since).get(),
    db.collection(COL.conversations).where('updatedAt', '>=', new Date(Date.now() - 7 * 86400_000)).get(),
    db.collection('zhu_vitals_cost').where('timestamp', '>=', since).get(),
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
  const TYPE_LABEL: Record<string, string> = {
    image: '圖片生成', audio: '音訊生成', video: '影片生成', podcast: 'Podcast',
    script_draft: '腳本草稿', story_draft: '故事草稿',
  };
  const funnel: Record<string, { ok: number; fail: number; running: number; stuck: number }> = {};
  const bump = (f: string, k: 'ok' | 'fail' | 'running' | 'stuck') => {
    funnel[f] = funnel[f] || { ok: 0, fail: 0, running: 0, stuck: 0 };
    funnel[f][k]++;
  };
  const failures: Row[] = [];

  for (const d of tasksSnap.docs) {
    const t = d.data() as { type?: string; status?: string; error?: string; userId?: string; characterId?: string; createdAt?: unknown };
    const feature = TYPE_LABEL[t.type || ''] || `任務(${t.type})`;
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
  failures.sort((a, b) => b.at - a.at);
  const stuckTotal = Object.values(funnel).reduce((s, f) => s + f.stuck, 0);

  // ── 第三方：LLM 從 cost 明細聚合；其餘 Phase 1 只有被動證據或灰燈 ──
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
  const videoFails = failures.filter(f => f.feature === '影片生成' && f.kind === 'fail');
  const providers = [
    { name: 'Anthropic 直連', use: '語音 turn-path', calls: llm.anthropic?.calls ?? 0, fails: null, lastOkAt: llm.anthropic?.lastAt ?? null, lastError: null, cost: llm.anthropic?.cost ?? null, phase2: false },
    { name: 'Bridge（Max）', use: '文字/文件/記憶', calls: llm.bridge?.calls ?? 0, fails: null, lastOkAt: llm.bridge?.lastAt ?? null, lastError: null, cost: 0, costNote: '月費內', phase2: false },
    { name: 'LiveKit Cloud', use: 'WebRTC 房間', calls: null, fails: roomsResult?.ok ? 0 : 1, lastOkAt: roomsResult?.ok ? now : null, lastError: roomsResult && !roomsResult.ok ? roomsResult.err : null, cost: null, costNote: '方案內', phase2: false },
    { name: 'FAL（Kling）', use: '影片生成', calls: null, fails: videoFails.length, lastOkAt: null, lastError: videoFails[0]?.error ?? null, cost: null, phase2: false, partial: true },
    { name: 'MiniMax TTS', use: '語音合成/podcast', calls: null, fails: null, lastOkAt: null, lastError: null, cost: null, phase2: true },
    { name: 'Soniox STT', use: '語音辨識', calls: null, fails: null, lastOkAt: null, lastError: null, cost: null, phase2: true },
    { name: 'Vertex Embeddings', use: '記憶/知識檢索', calls: null, fails: null, lastOkAt: null, lastError: null, cost: null, phase2: true },
    { name: 'media-worker', use: '圖/音派發', calls: null, fails: null, lastOkAt: null, lastError: null, cost: null, phase2: true },
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
    { key: 'cron', name: 'cron 心跳 ×3', status: 'gray', why: 'Phase 2 接心跳 doc' },
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
    funnel: [
      { feature: '文字對話', phase2: true },
      { feature: '語音通話', phase2: true },
      ...Object.entries(funnel).map(([feature, f]) => ({ feature, ...f, phase2: false })),
    ],
    failures: failures.slice(0, 20),
    providers,
    docsWindow: docsSnap.size,
  });
}
