/**
 * ops-event — 監控事件脊椎（Phase 2）
 *
 * 天條：
 *  - fire-and-forget、絕不 throw、絕不 await 阻塞主流程——監控掛了不能拖垮業務
 *  - 事件是「筆記」不是「帳」：允許偶爾丟失（帳務類寫入走 quota transaction，不走這裡）
 *  - 30 天 TTL（expires_at 欄位 + Firestore TTL 政策），監控資料不無限堆積
 *
 * 事件種類：
 *  - dialogue            文字對話成敗（dialogue route）
 *  - provider_call       第三方呼叫結果（bridge/minimax-tts/vertex-embeddings/fal/media-worker）
 *  - cron_run            排程心跳（三條 cron 跑完各寫一筆）
 *  - side_effect_error   被吞掉的副作用錯誤（after() 記憶抽取/派發/關係更新——吞可以，吞之前留痕）
 *
 * 語音 session 走獨立 collection `voice_sessions`（有狀態 doc，token 開 / voice-end 關），
 * 不塞進事件流——session 是「現在進行式的實體」，事件是「已發生的史實」。
 */
import { after } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';

const TTL_DAYS = 30;

/**
 * Vercel 雷（2026-07-11 實踩）：回應送出後 lambda 凍結，`void promise` 的寫入沒 flush 就死。
 * 一律用 next/server after() 排程——回應後保證執行；非 request 環境（理論上不會）降級 best-effort。
 */
function scheduleWrite(work: () => Promise<unknown>): void {
  const safe = () => work().catch(err => console.error('[ops-event] write failed:', err instanceof Error ? err.message : String(err)));
  try {
    after(safe);
  } catch {
    void safe();
  }
}

export type OpsEventKind = 'dialogue' | 'provider_call' | 'cron_run' | 'side_effect_error';

export interface OpsEvent {
  kind: OpsEventKind;
  status: 'ok' | 'fail';
  /** provider_call 用：bridge / minimax-tts / vertex-embeddings / fal / media-worker */
  provider?: string;
  /** cron_run 用：memory-consolidation / memory-maintenance / voice-auto-off */
  cron?: string;
  /** side_effect_error 用：哪個副作用（memory_extract / diary / relationship / doc_dispatch / task_dispatch） */
  sideEffect?: string;
  userId?: string;
  characterId?: string;
  latencyMs?: number;
  error?: string;
  meta?: Record<string, string | number | boolean>;
}

export function recordOpsEvent(e: OpsEvent): void {
  try {
    const now = Date.now();
    const doc: Record<string, unknown> = {
      ...e,
      at: new Date(now),
      expires_at: new Date(now + TTL_DAYS * 86400_000),
    };
    if (e.error) doc.error = e.error.slice(0, 300); else delete doc.error;
    scheduleWrite(() => getFirestore().collection('ops_events').add(doc));
  } catch (err) {
    console.error('[ops-event] unexpected:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * cron 心跳包裝：跑完寫一筆 cron_run（監控燈號以「最後成功心跳距今多久」判紅綠）。
 * 401（鑑權擋掉的外部戳）不算心跳；throw 記 fail 後原樣拋出。
 */
export function wrapCron(
  cron: string,
  run: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const started = Date.now();
    try {
      const res = await run(req);
      if (res.status !== 401) {
        recordOpsEvent({ kind: 'cron_run', status: res.ok ? 'ok' : 'fail', cron, latencyMs: Date.now() - started });
      }
      return res;
    } catch (e) {
      recordOpsEvent({ kind: 'cron_run', status: 'fail', cron, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };
}

/** 語音 session 開盤（token route 發 token 成功時）。docId = roomName（天然冪等）。 */
export function openVoiceSession(roomName: string, userId: string, characterId: string, voiceVersion: string): void {
  try {
    const now = Date.now();
    scheduleWrite(() => getFirestore().collection('voice_sessions').doc(roomName).set({
      roomName, userId, characterId, voiceVersion,
      status: 'open',
      startedAt: new Date(now),
      expires_at: new Date(now + TTL_DAYS * 86400_000),
    }));
  } catch { /* 監控不擋業務 */ }
}

/**
 * 語音 session 收盤（voice-end beacon）。
 * 有 roomName 直接關；沒有（舊前端快取）就 fallback 找該 (userId, characterId) 最新的 open。
 */
export async function closeVoiceSession(userId: string, characterId: string, roomName?: string): Promise<void> {
  try {
    const db = getFirestore();
    let ref = roomName ? db.collection('voice_sessions').doc(roomName) : null;
    if (ref && !(await ref.get()).exists) ref = null;
    if (!ref) {
      const open = await db.collection('voice_sessions')
        .where('userId', '==', userId).where('characterId', '==', characterId)
        .where('status', '==', 'open').get();
      const latest = open.docs
        .sort((a, b) => (b.data().startedAt?.toMillis?.() ?? 0) - (a.data().startedAt?.toMillis?.() ?? 0))[0];
      if (!latest) return;
      ref = latest.ref;
    }
    const snap = await ref.get();
    const startedMs = snap.data()?.startedAt?.toMillis?.() ?? Date.now();
    await ref.set({
      status: 'closed',
      endedAt: new Date(),
      durationS: Math.max(0, Math.round((Date.now() - startedMs) / 1000)),
    }, { merge: true });
  } catch (err) {
    console.error('[ops-event] close session failed:', err instanceof Error ? err.message : String(err));
  }
}
