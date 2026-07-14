/**
 * 記憶健康巡檢 —— 記憶系統的觀察者（2026-07-14）。
 *
 * 分工守天條：所有檢查都是確定性程式（計數/比對/餘弦），LLM（記憶觀察者）只在
 * 最後讀「程式算好的結果」寫一段診斷評語——評語掛了不影響巡檢結論。
 *
 * 檢查項（全部確定性）：
 *   1. 孤兒記憶：characterId / userId 對不到現存 doc（角色刪了記憶還在）
 *   2. 欄位完整性：缺 status / type / tier / embedding（管線寫入退化的信號）
 *   3. 積壓水位：stale/resolved 未清；archive 佔比異常
 *   4. 鞏固管線：watermark 之後的未消化情節積壓超過 48h（cron 可能卡住）
 *   5. embedding 脫鉤抽測：抽 N 條 active 記憶重新 embed 內容，跟庫存 embedding
 *      算 cosine——內容被改過（如 gist 化）但 embedding 沒跟上時，檢索會召回錯的東西。
 *      這是「檢索管線退化」唯一便宜又可自動化的鑑別信號。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import {
  COL,
  type MemoryDoc,
  type MemoryHealthFinding,
  type MemoryHealthRunDoc,
  type MemoryHealthStatus,
} from '@/lib/collections';
import { generateEmbedding, cosineSimilarity, EMBEDDING_DIMENSION } from '@/lib/embeddings';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

const SCAN_LIMIT = 3000;            // 現況 ~500 條，留 6 倍餘裕；超過就該分頁了（finding 會提醒）
const PROBE_SAMPLE = 8;             // 每輪抽測條數（8 次 Vertex embedding，成本可忽略）
const PROBE_DRIFT_THRESHOLD = 0.85; // 自身內容 re-embed 後 cosine 低於此 = 脫鉤
const CONSOLIDATION_LAG_MS = 48 * 3600_000;
const STALE_BACKLOG_WARN = 80;      // stale+resolved 積壓超過此數提醒清理
const MAX_IDS_KEPT = 20;

type MemoryWithId = MemoryDoc & { id: string };

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number };
  return typeof t.toMillis === 'function' ? t.toMillis() : 0;
}

export async function runMemoryHealthCheck(
  db: Firestore,
  trigger: 'cron' | 'manual',
): Promise<MemoryHealthRunDoc & { id: string }> {
  const started = Date.now();
  const findings: MemoryHealthFinding[] = [];

  // ── 收料：全量記憶 + 角色/用戶 id 集 + 印象 + 關係（watermark）──
  const [memSnap, charSnap, userSnap, impSnap, relSnap] = await Promise.all([
    db.collection(COL.memories).limit(SCAN_LIMIT).get(),
    db.collection(COL.characters).select().get(),
    db.collection(COL.users).select().get(),
    db.collection(COL.impressions).select().get(),
    db.collection(COL.relationships).get(),
  ]);

  if (memSnap.size >= SCAN_LIMIT) {
    findings.push({
      severity: 'warn', kind: 'scan-cap',
      detail: `記憶總數達掃描上限 ${SCAN_LIMIT}，本輪只看得到前 ${SCAN_LIMIT} 條——巡檢程式該升級成分頁掃描了`,
    });
  }

  const memories: MemoryWithId[] = memSnap.docs.map(d => ({ ...(d.data() as MemoryDoc), id: d.id }));
  const charIds = new Set(charSnap.docs.map(d => d.id));
  const userIds = new Set(userSnap.docs.map(d => d.id));

  // ── 1+2+3. 單迴圈掃：孤兒 / 缺欄 / 分佈 ──
  const byTier: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const pairs = new Set<string>();
  const orphanIds: string[] = [];
  const missingStatus: string[] = [];
  const missingType: string[] = [];
  const missingTier: string[] = [];
  const badEmbedding: string[] = [];

  for (const m of memories) {
    pairs.add(`${m.userId}_${m.characterId}`);
    byTier[m.tier ?? '(缺)'] = (byTier[m.tier ?? '(缺)'] ?? 0) + 1;
    byStatus[m.status ?? '(缺)'] = (byStatus[m.status ?? '(缺)'] ?? 0) + 1;
    byType[m.type ?? '(缺)'] = (byType[m.type ?? '(缺)'] ?? 0) + 1;

    if ((m.characterId && !charIds.has(m.characterId)) || (m.userId && !userIds.has(m.userId))) {
      orphanIds.push(m.id);
    }
    if (!m.status) missingStatus.push(m.id);
    if (!m.type) missingType.push(m.id);
    if (!m.tier) missingTier.push(m.id);
    if (!Array.isArray(m.embedding) || m.embedding.length !== EMBEDDING_DIMENSION) {
      badEmbedding.push(m.id);
    }
  }

  if (orphanIds.length > 0) {
    findings.push({
      severity: 'fail', kind: 'orphan',
      detail: `${orphanIds.length} 條記憶的角色或用戶已不存在（孤兒——佔庫存又永遠不會被召回）`,
      count: orphanIds.length, ids: orphanIds.slice(0, MAX_IDS_KEPT),
    });
  }
  for (const [ids, field] of [[missingStatus, 'status'], [missingType, 'type'], [missingTier, 'tier']] as const) {
    if (ids.length > 0) {
      findings.push({
        severity: 'warn', kind: 'missing-field',
        detail: `${ids.length} 條記憶缺 ${field} 欄位（寫入管線某條路徑沒帶全欄位）`,
        count: ids.length, ids: ids.slice(0, MAX_IDS_KEPT),
      });
    }
  }
  if (badEmbedding.length > 0) {
    findings.push({
      severity: 'warn', kind: 'missing-embedding',
      detail: `${badEmbedding.length} 條記憶 embedding 缺失或維度不對（檢索時它們永遠拿 0 分）`,
      count: badEmbedding.length, ids: badEmbedding.slice(0, MAX_IDS_KEPT),
    });
  }
  const staleBacklog = (byStatus['stale'] ?? 0) + (byStatus['resolved'] ?? 0);
  if (staleBacklog > STALE_BACKLOG_WARN) {
    findings.push({
      severity: 'info', kind: 'backlog',
      detail: `stale/resolved 積壓 ${staleBacklog} 條（不影響檢索，但該考慮歸檔或清理節律）`,
      count: staleBacklog,
    });
  }

  // ── 4. 鞏固管線卡住偵測：watermark 之後有 >48h 的 fact/preference 沒被消化 ──
  const now = Date.now();
  const watermarkByPair = new Map<string, number>();
  for (const d of relSnap.docs) {
    watermarkByPair.set(d.id, toMillis((d.data() as { consolidationWatermark?: unknown }).consolidationWatermark));
  }
  const stuckPairs = new Set<string>();
  for (const m of memories) {
    if (m.type !== 'fact' && m.type !== 'preference') continue;
    const created = toMillis(m.createdAt);
    if (!created || now - created < CONSOLIDATION_LAG_MS) continue;
    const wm = watermarkByPair.get(`${m.userId}_${m.characterId}`) ?? 0;
    if (created > wm) stuckPairs.add(`${m.userId}_${m.characterId}`);
  }
  if (stuckPairs.size > 0) {
    findings.push({
      severity: 'warn', kind: 'consolidation-stuck',
      detail: `${stuckPairs.size} 個配對有超過 48 小時未消化的情節（鞏固 cron 可能卡住或該配對持續失敗）`,
      count: stuckPairs.size, ids: [...stuckPairs].slice(0, MAX_IDS_KEPT),
    });
  }

  // ── 5. embedding 脫鉤抽測：re-embed 內容 vs 庫存 embedding ──
  const probeCandidates = memories.filter(m =>
    (m.status ?? 'active') === 'active'
    && typeof m.content === 'string' && m.content.trim().length >= 4
    && Array.isArray(m.embedding) && m.embedding.length === EMBEDDING_DIMENSION,
  );
  // 洗牌抽樣（cron 每輪抽不同條，長期覆蓋全庫）
  for (let i = probeCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [probeCandidates[i], probeCandidates[j]] = [probeCandidates[j], probeCandidates[i]];
  }
  const sample = probeCandidates.slice(0, PROBE_SAMPLE);
  const driftedIds: string[] = [];
  const selfCosines: number[] = [];
  for (const m of sample) {
    try {
      const fresh = await generateEmbedding(m.content);
      const cos = cosineSimilarity(fresh, m.embedding as number[]);
      selfCosines.push(cos);
      if (cos < PROBE_DRIFT_THRESHOLD) driftedIds.push(m.id);
    } catch {
      findings.push({
        severity: 'warn', kind: 'probe-error',
        detail: 'Vertex embedding 呼叫失敗——抽測中斷，本身就是檢索管線的壞信號',
      });
      break;
    }
  }
  if (driftedIds.length > 0) {
    findings.push({
      severity: 'fail', kind: 'embedding-drift',
      detail: `${driftedIds.length}/${sample.length} 條抽測記憶「內容 re-embed 後與庫存 embedding 對不上」（cosine < ${PROBE_DRIFT_THRESHOLD}）——內容被改過但 embedding 沒跟上，檢索會召回錯的東西`,
      count: driftedIds.length, ids: driftedIds,
    });
  }

  // ── 收斂結論 ──
  const status: MemoryHealthStatus =
    findings.some(f => f.severity === 'fail') ? 'fail'
    : findings.some(f => f.severity === 'warn') ? 'warn'
    : 'ok';

  const canary = (v: string | undefined) => {
    const s = (v || '').trim();
    return !s ? '關' : s === '*' ? '全開' : `白名單：${s}`;
  };

  const run: MemoryHealthRunDoc = {
    triggeredAt: Timestamp.fromMillis(started),
    trigger,
    status,
    durationMs: 0, // 觀察者評語寫完後回填
    summary: {
      total: memSnap.size,
      byTier, byStatus, byType,
      pairs: pairs.size,
      impressions: impSnap.size,
      orphans: orphanIds.length,
      probe: {
        sampled: sample.length,
        drifted: driftedIds.length,
        avgSelfCos: selfCosines.length
          ? Math.round((selfCosines.reduce((a, b) => a + b, 0) / selfCosines.length) * 1000) / 1000
          : null,
      },
    },
    findings,
    pipelines: {
      impressions: canary(process.env.IMPRESSION_CANARY_USERS),
      gist: canary(process.env.GIST_CANARY_USERS),
      diary: canary(process.env.DIARY_CANARY_USERS),
    },
    observerComment: null,
  };

  run.observerComment = await writeObserverComment(run).catch(() => null);
  run.durationMs = Date.now() - started;

  const ref = await db.collection(COL.memoryHealthRuns).add(run);
  return { ...run, id: ref.id };
}

/**
 * 記憶觀察者 —— 讀確定性巡檢結果寫診斷評語（判斷與語言是 LLM 的活，數字不是）。
 * 走 bridge（月費內）；任何失敗回 null，不影響巡檢結論。
 */
async function writeObserverComment(run: MemoryHealthRunDoc): Promise<string | null> {
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 60_000 });
  const payload = {
    status: run.status,
    summary: run.summary,
    pipelines: run.pipelines,
    findings: run.findings.map(f => ({ severity: f.severity, kind: f.kind, detail: f.detail })),
  };
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system:
      '你是「記憶觀察者」——這個平台記憶庫的檢驗員。個性：冷靜、簡短、只說證據支持的話。' +
      '你收到一份程式算好的巡檢結果（數字都已驗證，不要重算、不要質疑數字）。' +
      'pipelines 欄的「關」是 canary 刻意未開的正常狀態，不是故障，不要當問題報。' +
      '用繁體中文寫 2-4 句診斷評語給管理者：先一句總體結論，再點出最值得注意的一兩件事' +
      '（若一切正常就說正常，不要沒事找事）。純文字：不用列點、標題、粗體、emoji。',
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => (b as { text: string }).text).join('').trim();
  return text || null;
}
