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
import { parseJsonLoose } from '@/lib/safe-json';
import { impressionsEnabled, loadActiveImpressions, buildImpressionSections } from '@/lib/impressions';

const MAX_FACTS = 4;
const MAX_EMOTIONS = 2;
const MAX_PREFERENCES = 3;
const MAX_PROMISES = 2;
const MAX_QUESTIONS = 2;
const MAX_MILESTONES = 2;
const SEMANTIC_FLOOR = 0.25;
const DEDUP_THRESHOLD = 0.9;
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

    // 印象模式（記憶全景圖第二期，canary）：fact/preference 改由印象層供給，
    // 已被吸收進印象的情節（consolidatedInto 有值）不再直接進 prompt——它們活在信念裡。
    const useImpressions = impressionsEnabled(userId);

    const raw: MemoryWithId[] = snap.docs
      .map(d => ({ ...(d.data() as MemoryDoc), id: d.id }))
      .filter(m => m.tier !== 'archive' && (m.status ?? 'active') !== 'stale' && (m.status ?? 'active') !== 'resolved')
      .filter(m => !(useImpressions && m.consolidatedInto));

    // lazy stale check（不阻塞，fire-and-forget update）
    const all = await checkAndMarkStale(db, raw);
    if (all.length === 0 && !rel && !useImpressions) return '';

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

    // ── 混合檢索：六型全參與（相關性 × tier × importance）─────────────────
    // cosine 主分 + 詞彙重疊 boost（專有名詞救援：embedding 對低頻人名/代號弱）
    // + core 加成 + importance 微調。無 query 時退回 tier/importance 頭部。
    const qEmb = query?.trim() ? await generateEmbedding(query).catch(() => null) : null;
    const qTerms = query?.trim() ? lexTerms(query) : [];

    const rank = (list: MemoryWithId[], cap: number, semantic: boolean): MemoryWithId[] => {
      if (!semantic || !qEmb) return list.slice(0, cap);
      return list
        .map(m => {
          const cos = Array.isArray(m.embedding) && m.embedding.length > 0
            ? cosineSimilarity(qEmb, m.embedding as number[]) : 0;
          const lex = lexOverlap(qTerms, m.content ?? '');
          const tierBonus = m.tier === 'core' ? 0.06 : 0;
          const impBonus = ((m.importance ?? 5) - 5) * 0.01;
          return { m, score: cos * 0.7 + lex * 0.3 + tierBonus + impBonus, cos, lex };
        })
        // 語義或詞彙任一有訊號才算相關；都沒有就靠 tier/importance 保底補位
        .sort((a, b) => b.score - a.score)
        .filter((x, i) => i < cap && (x.cos >= SEMANTIC_FLOOR || x.lex > 0 || i < Math.ceil(cap / 2)))
        .map(x => x.m);
    };

    const pickedFacts       = rank(facts, MAX_FACTS, true);
    const pickedEmotions    = rank(emotions, MAX_EMOTIONS, true);
    const pickedPreferences = rank(preferences, MAX_PREFERENCES, true);
    const pickedPromises    = rank(promises, MAX_PROMISES, true);
    const pickedQuestions   = questions.slice(0, MAX_QUESTIONS); // 懸而未決照時間門檻，不看相關性
    const pickedMilestones  = rank(milestones, MAX_MILESTONES, true);

    const allPicked = [
      ...pickedFacts, ...pickedEmotions, ...pickedPreferences,
      ...pickedPromises, ...pickedQuestions, ...pickedMilestones,
    ];
    if (allPicked.length === 0 && !rel && !useImpressions) return '';

    void bumpHits(db, allPicked);

    // ── 組 7 區塊 ──────────────────────────────────────────────────────────────
    const parts: string[] = [];

    // 1. 關係
    if (rel) {
      const count = rel.conversationCount ?? 1;
      const since = relativeTime(rel.firstConversationAt as FirebaseFirestore.Timestamp | Date);
      parts.push(`\n\n【關係】\n我們已經聊過 ${count} 次${since ? `，第一次是 ${since}` : ''}。`);
    }

    // 2+4. 了解／習慣：印象模式吃印象層（信念＋信心口吻）＋新鮮未消化情節補位；
    //       否則走原始情節（舊行為，canary 外用戶零變化）
    if (useImpressions) {
      const impressions = await loadActiveImpressions(db, userId, characterId).catch(() => []);
      const { factSection, prefSection } = buildImpressionSections(impressions, qEmb, {
        factLines: pickedFacts.map(m => fmt(m)),
        prefLines: pickedPreferences.map(m => m.content),
      });
      if (factSection) parts.push(factSection);
      if (pickedEmotions.length > 0)
        parts.push(`\n\n【他的情緒記憶】\n${pickedEmotions.map(m => `- ${fmt(m)}`).join('\n')}`);
      if (prefSection) parts.push(prefSection);
    } else {
      if (pickedFacts.length > 0)
        parts.push(`\n\n【我對這個人的了解】\n${pickedFacts.map(m => `- ${fmt(m)}`).join('\n')}`);

      // 3. 情緒記憶
      if (pickedEmotions.length > 0)
        parts.push(`\n\n【他的情緒記憶】\n${pickedEmotions.map(m => `- ${fmt(m)}`).join('\n')}`);

      // 4. 習慣偏好
      if (pickedPreferences.length > 0)
        parts.push(`\n\n【我記得他的習慣】\n${pickedPreferences.map(m => `- ${m.content}`).join('\n')}`);
    }

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
    const isDup = await isDuplicate(db, userId, characterId, embedding, opts?.type ?? 'fact', content);
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

  // 撈懸而未決的 question：讓這輪萃取順便判斷哪些已被回答（→ resolved，角色不再追問）
  const openQSnap = await db.collection(COL.memories)
    .where('userId', '==', userId)
    .where('characterId', '==', characterId)
    .where('type', '==', 'question')
    .limit(10)
    .get()
    .catch(() => null);
  const openQuestions = (openQSnap?.docs ?? [])
    .map(d => ({ id: d.id, ...(d.data() as MemoryDoc) }))
    .filter(q => (q.status ?? 'active') === 'active');
  const openQBlock = openQuestions.length > 0
    ? `\n\n目前懸而未決的事（如果這段對話已經回答/解決了其中某些，把編號列進 <resolved>）：\n${openQuestions.map((q, i) => `${i + 1}. ${q.content}`).join('\n')}`
    : '';

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
content 欄位一律用繁體中文輸出。

<result>
[{"content": "...", "type": "fact", "importance": 7}]
</result>${openQuestions.length > 0 ? '\n<resolved>[1, 3]</resolved>（沒有已解決的就輸出 <resolved>[]</resolved>）' : ''}${openQBlock}`;

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

    // resolved 標記：LLM 只回編號，映射與寫入由程式做
    if (openQuestions.length > 0) {
      const rm = text.match(/<resolved>([\s\S]*?)<\/resolved>/);
      if (rm) {
        const nums = parseJsonLoose<number[]>(rm[1].trim());
        if (Array.isArray(nums)) {
          for (const n of nums) {
            const q = openQuestions[n - 1];
            if (q) {
              await db.collection(COL.memories).doc(q.id).update({ status: 'resolved' }).catch(() => {});
              console.info('[extraction] question resolved:', q.content.slice(0, 40));
            }
          }
        }
      }
    }

    const match = text.match(/<result>([\s\S]*?)<\/result>/);
    if (!match) return;

    const candidates = parseJsonLoose<Array<{
      content: string; type: string; importance: number;
    }>>(match[1].trim());
    if (!Array.isArray(candidates) || candidates.length === 0) {
      if (candidates === null) {
        console.warn('[extraction] LLM 輸出無法解析為 JSON，略過：', match[1].trim().slice(0, 200));
      }
      return;
    }

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

/** 兩段文字的 CJK bigram 重疊率（0~1，以較短者為分母）——真重複必然逐字高度相似 */
function bigramOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const cjk = s.match(/[\u4e00-\u9fff]/g) ?? [];
    const out = new Set<string>();
    for (let i = 0; i < cjk.length - 1; i++) out.add(cjk[i] + cjk[i + 1]);
    return out;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** query → 詞項：CJK 取 bigram，拉丁/數字取整詞（≥2字）。純程式，無 LLM。 */
function lexTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const w of query.match(/[a-zA-Z0-9]{2,}/g) ?? []) terms.add(w.toLowerCase());
  const cjk = query.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk[i] + cjk[i + 1]);
  return [...terms];
}

/** 詞彙重疊率 0~1：query 詞項有多少出現在記憶內容裡 */
function lexOverlap(terms: string[], content: string): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let hit = 0;
  for (const t of terms) if (lower.includes(t)) hit++;
  return hit / terms.length;
}

async function isDuplicate(db: Firestore, userId: string, characterId: string, embedding: number[], type: string, content: string): Promise<boolean> {
  try {
    const snap = await db.collection(COL.memories)
      .where('userId', '==', userId)
      .where('characterId', '==', characterId)
      .where('type', '==', type)
      .limit(50)
      .get();
    for (const doc of snap.docs) {
      const m = doc.data() as MemoryDoc;
      if (Array.isArray(m.embedding) && m.embedding.length > 0) {
        // 雙門檻：cosine 高 AND 詞彙重疊高才算重複。
        // 長篇敘事記憶（同人物同語域）光 cosine 會把不同事件誤判成重複（牧羊人 vs 咖啡館事故）。
        if (cosineSimilarity(embedding, m.embedding as number[]) >= DEDUP_THRESHOLD
            && bigramOverlap(content, m.content ?? '') >= 0.5) return true;
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
