/**
 * Per (用戶 × 角色) 記憶 —— ailiveX 核心 v2。
 *
 * v2 升級：
 * - 6 種 type：fact / emotion / preference / promise / question / milestone
 * - 7 區塊 system prompt（關係/了解/情緒/習慣/答應/懸而未決/重要時刻）
 * - 時間感：每條記憶前綴相對時間（今天/X天前/X個月前...）
 * - Relationship 區塊：幾次對話、認識多久
 * - Active recall：question > 7天 自然帶進「懸而未決」
 * - Stale：question > 60天、emotion > 90天 → lazy mark stale，不帶進 prompt
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL, type MemoryDoc, type MemoryType, type MemoryStatus, type RelationshipDoc } from '@/lib/collections';
import { generateEmbedding, cosineSimilarity } from '@/lib/embeddings';

const MAX_FACTS = 4;
const MAX_EMOTIONS = 2;
const MAX_PREFERENCES = 3;
const MAX_PROMISES = 2;
const MAX_QUESTIONS = 2;
const MAX_MILESTONES = 2;
const SEMANTIC_FLOOR = 0.25;
const DEDUP_THRESHOLD = 0.85;
const TIER_PROMOTE_HITS = 3;

const STALE_DAYS: Partial<Record<MemoryType, number>> = {
  question: 60,
  emotion: 90,
};
const ACTIVE_RECALL_DAYS = 7;

type MemoryWithId = MemoryDoc & { id: string };

// ─── 時間顯示 helper ──────────────────────────────────────────────────────────

function relativeTime(date: FirebaseFirestore.Timestamp | Date | null | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : (date as { toDate(): Date }).toDate();
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 1) return '今天';
  if (diffDays < 7) return `${diffDays}天前`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}週前`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}個月前`;
  return `${Math.floor(diffMonths / 12)}年前`;
}

function fmt(m: MemoryWithId): string {
  const t = relativeTime(m.createdAt as FirebaseFirestore.Timestamp | Date);
  return t ? `(${t}) ${m.content}` : m.content;
}

// ─── Stale lazy check ─────────────────────────────────────────────────────────

async function checkAndMarkStale(db: Firestore, mems: MemoryWithId[]): Promise<MemoryWithId[]> {
  const now = Date.now();
  const active: MemoryWithId[] = [];
  const toStale: string[] = [];

  for (const m of mems) {
    const status = (m.status as MemoryStatus | undefined) ?? 'active';
    if (status !== 'active') continue;
    const staleDays = STALE_DAYS[m.type];
    if (staleDays) {
      const created = m.createdAt instanceof Date
        ? m.createdAt
        : (m.createdAt as { toDate(): Date }).toDate();
      const ageDays = (now - created.getTime()) / 86400000;
      if (ageDays > staleDays) { toStale.push(m.id); continue; }
    }
    active.push(m);
  }

  if (toStale.length > 0) {
    await Promise.all(
      toStale.map(id => db.collection(COL.memories).doc(id).update({ status: 'stale' }).catch(() => {}))
    );
  }
  return active;
}

// ─── 讀 ──────────────────────────────────────────────────────────────────────

export async function loadMemoryBlock(
  db: Firestore,
  userId: string,
  characterId: string,
  query?: string,
): Promise<string> {
  if (!userId || !characterId) return '';
  try {
    // 並行：讀記憶 + 讀關係
    const [snap, relSnap] = await Promise.all([
      db.collection(COL.memories)
        .where('userId', '==', userId)
        .where('characterId', '==', characterId)
        .limit(120)
        .get(),
      db.collection(COL.relationships)
        .doc(`${userId}_${characterId}`)
        .get(),
    ]);

    const rel = relSnap.exists ? (relSnap.data() as RelationshipDoc) : null;

    const raw: MemoryWithId[] = snap.docs
      .map(d => ({ ...(d.data() as MemoryDoc), id: d.id }))
      .filter(m => m.tier !== 'archive' && (m.status ?? 'active') !== 'stale' && (m.status ?? 'active') !== 'resolved');

    // lazy stale check（不阻塞，fire-and-forget update）
    const all = await checkAndMarkStale(db, raw);
    if (all.length === 0 && !rel) return '';

    // 分類
    const byType = (t: MemoryType) => all.filter(m => m.type === t);
    const facts       = byTierHit(byType('fact'));
    const emotions    = byTierHit(byType('emotion'));
    const preferences = byTierHit(byType('preference'));
    const promises    = byTierHit(byType('promise'));
    const milestones  = byTierHit(byType('milestone'));

    // question：分成 active-recall（>7天）和一般
    const now = Date.now();
    const questions = byType('question').filter(m => {
      const created = m.createdAt instanceof Date
        ? m.createdAt
        : (m.createdAt as { toDate(): Date }).toDate();
      return (now - created.getTime()) / 86400000 >= ACTIVE_RECALL_DAYS;
    });

    // 語義排序 facts（如果有 query）
    let pickedFacts = facts.slice(0, MAX_FACTS);
    if (query?.trim() && facts.length > 0) {
      const withEmb = facts.filter(m => Array.isArray(m.embedding) && m.embedding.length > 0);
      const qEmb = withEmb.length > 0 ? await generateEmbedding(query).catch(() => null) : null;
      if (qEmb) {
        pickedFacts = withEmb
          .map(m => ({ m, score: cosineSimilarity(qEmb, m.embedding as number[]) }))
          .filter(x => x.score >= SEMANTIC_FLOOR)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_FACTS)
          .map(x => x.m);
      }
    }

    const pickedEmotions    = emotions.slice(0, MAX_EMOTIONS);
    const pickedPreferences = preferences.slice(0, MAX_PREFERENCES);
    const pickedPromises    = promises.slice(0, MAX_PROMISES);
    const pickedQuestions   = questions.slice(0, MAX_QUESTIONS);
    const pickedMilestones  = milestones.slice(0, MAX_MILESTONES);

    const allPicked = [
      ...pickedFacts, ...pickedEmotions, ...pickedPreferences,
      ...pickedPromises, ...pickedQuestions, ...pickedMilestones,
    ];
    if (allPicked.length === 0 && !rel) return '';

    void bumpHits(db, allPicked);

    // ── 組 7 區塊 ──────────────────────────────────────────────────────────────
    const parts: string[] = [];

    // 1. 關係
    if (rel) {
      const count = rel.conversationCount ?? 1;
      const since = relativeTime(rel.firstConversationAt as FirebaseFirestore.Timestamp | Date);
      parts.push(`\n\n【關係】\n我們已經聊過 ${count} 次${since ? `，第一次是 ${since}` : ''}。`);
    }

    // 2. 了解
    if (pickedFacts.length > 0)
      parts.push(`\n\n【我對這個人的了解】\n${pickedFacts.map(m => `- ${fmt(m)}`).join('\n')}`);

    // 3. 情緒記憶
    if (pickedEmotions.length > 0)
      parts.push(`\n\n【他的情緒記憶】\n${pickedEmotions.map(m => `- ${fmt(m)}`).join('\n')}`);

    // 4. 習慣偏好
    if (pickedPreferences.length > 0)
      parts.push(`\n\n【我記得他的習慣】\n${pickedPreferences.map(m => `- ${m.content}`).join('\n')}`);

    // 5. 答應過的事
    if (pickedPromises.length > 0)
      parts.push(`\n\n【我答應過的事】\n${pickedPromises.map(m => `- ${m.content}`).join('\n')}`);

    // 6. 懸而未決（active recall — 角色自然跟進）
    if (pickedQuestions.length > 0)
      parts.push(`\n\n【懸而未決的事】\n${pickedQuestions.map(m => `- ${fmt(m)}`).join('\n')}`);

    // 7. 重要時刻
    if (pickedMilestones.length > 0)
      parts.push(`\n\n【重要時刻】\n${pickedMilestones.map(m => `- ${fmt(m)}`).join('\n')}`);

    if (parts.length === 0) return '';
    return parts.join('') + '\n\n（以上是你對這個人的了解，自然帶進對話，不要逐條列舉。）';
  } catch (e) {
    console.error('[memory] loadMemoryBlock failed:', e instanceof Error ? e.message : String(e));
    return '';
  }
}

// ─── 寫 ──────────────────────────────────────────────────────────────────────

export async function writeMemory(
  db: Firestore,
  userId: string,
  characterId: string,
  content: string,
  opts?: { importance?: number; source?: string; tier?: MemoryDoc['tier']; type?: MemoryType },
): Promise<void> {
  if (!userId || !characterId || !content.trim()) return;

  const embedding = await generateEmbedding(content).catch(() => null);

  // dedup：有 embedding 才查，查不到或失敗就放行
  if (embedding) {
    const isDup = await isDuplicate(db, userId, characterId, embedding);
    if (isDup) {
      console.info('[memory] skipped duplicate:', content.slice(0, 60));
      return;
    }
  }

  const doc: MemoryDoc = {
    userId,
    characterId,
    content: content.trim(),
    ...(embedding ? { embedding } : {}),
    importance: opts?.importance ?? 5,
    tier: opts?.tier ?? 'fresh',
    type: opts?.type ?? 'fact',
    hitCount: 0,
    lastHitAt: null,
    source: opts?.source ?? 'conversation',
    createdAt: new Date(),
  };
  await db.collection(COL.memories).add(doc);
}

// ─── Extraction ───────────────────────────────────────────────────────────────

const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

type LLMClient = {
  messages: {
    create: (args: {
      model: string; max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

/**
 * 對話結束後異步提煉記憶。傳入最近 N 條 messages，走 bridge（吃到飽）。
 * 不阻塞主流程，失敗靜默。
 */
export async function extractAndSaveMemories(
  db: Firestore,
  userId: string,
  characterId: string,
  charName: string,
  messages: Array<{ role: string; content: string }>,
  client: LLMClient,
): Promise<void> {
  if (!userId || !characterId || messages.length < 2) return;

  const conversation = messages
    .slice(-20)
    .map(m => `${m.role === 'user' ? '用戶' : charName}：${m.content as string}`)
    .join('\n');

  const prompt = `你是記憶提煉師。從以下對話，提取「${charName}」值得長期記住的信息。

對話：
${conversation}

提取規則（六種 type）：
- fact：用戶分享的個人事實（工作、家庭、計畫）→ content 用「用戶...」
- emotion：用戶在談某件事時流露的情緒狀態 → content 用「談到XXX時，感覺...」；只記明顯信號，不猜測
- preference：用戶穩定的偏好或行為模式（非一次性）→ content 用「用戶偏好...」或「用戶習慣...」
- promise：角色對用戶的承諾 → content 用「我答應了...」
- question：用戶提出尚未解決、下次要跟進的事 → content 用「用戶還在考慮...」或「用戶想知道...」
- milestone：用戶生命中的重要轉折 → content 用「用戶...」

importance：1-10
只提取真正有價值的信息。閒聊不提取。沒有就回傳空陣列。

<result>
[{"content": "...", "type": "fact", "importance": 7}]
</result>`;

  try {
    const res = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');

    const match = text.match(/<result>([\s\S]*?)<\/result>/);
    if (!match) return;

    const candidates = JSON.parse(match[1].trim()) as Array<{
      content: string; type: string; importance: number;
    }>;
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    let written = 0;
    for (const c of candidates) {
      if (!c.content?.trim()) continue;
      const type: MemoryType = (['fact', 'emotion', 'preference', 'promise', 'question', 'milestone'] as const)
        .includes(c.type as MemoryType) ? c.type as MemoryType : 'fact';
      await writeMemory(db, userId, characterId, c.content, {
        importance: Math.min(10, Math.max(1, Number(c.importance) || 5)),
        source: 'extraction',
        type,
      });
      written++;
    }
    console.info(`[extraction] ${written} memories written for ${userId}×${characterId}`);
  } catch (e) {
    console.error('[extraction] failed:', e instanceof Error ? e.message : String(e));
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function byTierHit(all: MemoryWithId[]): MemoryWithId[] {
  const tierScore = (t: string) => (t === 'core' ? 2 : t === 'fresh' ? 1 : 0);
  return [...all].sort((a, b) => {
    const ta = tierScore(a.tier), tb = tierScore(b.tier);
    if (tb !== ta) return tb - ta;
    if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0);
    return (b.hitCount || 0) - (a.hitCount || 0);
  });
}

async function isDuplicate(db: Firestore, userId: string, characterId: string, embedding: number[]): Promise<boolean> {
  try {
    const snap = await db.collection(COL.memories)
      .where('userId', '==', userId)
      .where('characterId', '==', characterId)
      .limit(50)
      .get();
    for (const doc of snap.docs) {
      const m = doc.data() as MemoryDoc;
      if (Array.isArray(m.embedding) && m.embedding.length > 0) {
        if (cosineSimilarity(embedding, m.embedding as number[]) >= DEDUP_THRESHOLD) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function bumpHits(db: Firestore, mems: MemoryWithId[]): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore');
  await Promise.all(mems.map(async m => {
    const newCount = (m.hitCount || 0) + 1;
    const updates: Record<string, unknown> = {
      hitCount: FieldValue.increment(1),
      lastHitAt: new Date(),
    };
    if (m.tier === 'fresh' && newCount >= TIER_PROMOTE_HITS) updates.tier = 'core';
    return db.collection(COL.memories).doc(m.id).update(updates).catch(() => undefined);
  }));
}
