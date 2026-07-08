/**
 * 角色日記 —— 記憶全景圖第一期（2026-07-07）。
 *
 * 角色的獨立空間：對話結束後角色用第一人稱寫給自己，用戶永遠看不到。
 * 內容三件事：今天的感受（entry）、沒說出口的觀察（unspoken）、下次想跟進的（nextTime）。
 * 下次對話注入最近幾篇 → 角色說得出「上次我就想問你」這種只有惦記著才說得出的話。
 *
 * 分工守天條：LLM 只寫日記（生成）；canary 判斷、解析、驗證、裁剪、讀寫全是程式。
 * bridge 無 tool_use → <result> JSON + parseJsonLoose（與 extraction 同姿勢）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL, type DiaryDoc } from '@/lib/collections';
import { parseJsonLoose } from '@/lib/safe-json';

const DIARY_MODEL = 'claude-sonnet-4-6'; // 日記是角色的聲音，生成用 Sonnet（走 bridge 吃到飽）
const MAX_ENTRY_CHARS = 300;
const MAX_UNSPOKEN = 3;
const MAX_NEXT_TIME = 2;
const INJECT_RECENT = 3; // prompt 注入最近幾篇

type LLMClient = {
  messages: {
    create: (args: {
      model: string; max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

/**
 * Canary 閘：DIARY_CANARY_USERS 未設 = 全關；'*' = 全開；否則逗號分隔 userId 白名單。
 */
export function diaryEnabled(userId: string): boolean {
  const canary = (process.env.DIARY_CANARY_USERS || '').trim();
  if (!canary) return false;
  if (canary === '*') return true;
  return canary.split(',').map(s => s.trim()).includes(userId);
}

// ─── 讀：組 prompt 塊 ─────────────────────────────────────────────────────────

function relativeTime(date: FirebaseFirestore.Timestamp | Date | null | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : (date as { toDate(): Date }).toDate();
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays < 1) return '今天';
  if (diffDays < 7) return `${diffDays}天前`;
  const w = Math.floor(diffDays / 7);
  if (w < 5) return `${w}週前`;
  return `${Math.floor(diffDays / 30)}個月前`;
}

export async function loadDiaryBlock(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<string> {
  if (!diaryEnabled(userId)) return '';
  try {
    const snap = await db.collection(COL.diary)
      .where('userId', '==', userId)
      .where('characterId', '==', characterId)
      .orderBy('createdAt', 'desc')
      .limit(INJECT_RECENT)
      .get();
    if (snap.empty) return '';

    const entries = snap.docs.map(d => d.data() as DiaryDoc)
      .filter(e => (e.status ?? 'active') === 'active')
      .reverse(); // 舊→新
    if (entries.length === 0) return '';
    const lines = entries.map(e =>
      `（${relativeTime(e.createdAt as FirebaseFirestore.Timestamp | Date)}）${e.entry}`
    );
    const unspoken = entries.flatMap(e => e.unspoken || []).slice(-MAX_UNSPOKEN);
    const nextTime = entries.flatMap(e => e.nextTime || []).slice(-MAX_NEXT_TIME);

    const parts = [`\n\n【我私下的日記——只有我自己知道，對方看不到】\n${lines.join('\n')}`];
    if (unspoken.length > 0)
      parts.push(`\n我注意到但還沒說出口的：\n${unspoken.map(s => `- ${s}`).join('\n')}`);
    if (nextTime.length > 0)
      parts.push(`\n我想找機會問他/跟進的：\n${nextTime.map(s => `- ${s}`).join('\n')}`);
    parts.push('\n（這些是你自己的心事和惦記。時機自然就帶出來，不要一次全倒，也不要唸日記。）');
    return parts.join('\n');
  } catch (e) {
    console.error('[diary] loadDiaryBlock failed:', e instanceof Error ? e.message : String(e));
    return '';
  }
}

// ─── 寫：對話結束後生成 ───────────────────────────────────────────────────────

export async function writeDiaryEntry(
  db: Firestore,
  userId: string,
  characterId: string,
  charName: string,
  soul: string,
  userName: string,
  messages: Array<{ role: string; content: string }>,
  client: LLMClient,
  source: 'text' | 'voice' = 'text',
): Promise<void> {
  if (!diaryEnabled(userId)) return;
  if (messages.length < 2) return;

  try {
    // 前情：最近一篇日記（讓日記有連續性，不每天像第一次認識）
    const prevSnap = await db.collection(COL.diary)
      .where('userId', '==', userId)
      .where('characterId', '==', characterId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
      .catch(() => null);
    const prev = prevSnap && !prevSnap.empty ? (prevSnap.docs[0].data() as DiaryDoc) : null;

    const conversation = messages
      .slice(-16)
      .map(m => `${m.role === 'user' ? userName : charName}：${m.content}`)
      .join('\n');

    const prompt = `你是「${charName}」。你的靈魂：
${soul.slice(0, 400)}

你剛跟「${userName}」聊完這一段：
${conversation}
${prev ? `\n你上一篇日記寫的是：「${prev.entry}」\n` : ''}
現在夜深了，你私下寫幾句日記給自己——這是你自己的空間，${userName}永遠不會看到，所以誠實寫：
- entry：這次聊完你真實的感受（80-150字，第一人稱，用你自己的語氣，不要客套）
- unspoken：你注意到了、但當下沒說出口的事（0-3條；沒有就空陣列，不要硬掰）
- nextTime：你想找機會問他或跟進的事（0-2條；沒有就空陣列）
- mood：你此刻的心情，一兩個詞

只回 JSON：
<result>
{"entry": "...", "unspoken": ["..."], "nextTime": ["..."], "mood": "..."}
</result>`;

    const res = await client.messages.create({
      model: DIARY_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    const match = text.match(/<result>([\s\S]*?)<\/result>/);
    if (!match) { console.warn('[diary] no <result> tag'); return; }

    const parsed = parseJsonLoose<{
      entry?: string; unspoken?: string[]; nextTime?: string[]; mood?: string;
    }>(match[1].trim());
    if (!parsed || !parsed.entry?.trim()) {
      console.warn('[diary] parse failed or empty entry');
      return;
    }

    // 程式裁剪，不信任 LLM 自律
    const doc: DiaryDoc = {
      userId,
      characterId,
      entry: parsed.entry.trim().slice(0, MAX_ENTRY_CHARS),
      unspoken: (Array.isArray(parsed.unspoken) ? parsed.unspoken : [])
        .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).slice(0, MAX_UNSPOKEN),
      nextTime: (Array.isArray(parsed.nextTime) ? parsed.nextTime : [])
        .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).slice(0, MAX_NEXT_TIME),
      mood: (parsed.mood || '').trim().slice(0, 20),
      source,
      createdAt: new Date(),
    };
    await db.collection(COL.diary).add(doc);
    console.info(`[diary] entry written for ${userId}×${characterId}: ${doc.entry.slice(0, 40)}`);
  } catch (e) {
    // 日記失敗不影響任何主流程
    console.error('[diary] writeDiaryEntry failed:', e instanceof Error ? e.message : String(e));
  }
}

// ─── 生命週期：日記沉澱（連線批次④，2026-07-08）─────────────────────────────
// 人的日記會沉澱成「那段時間我常想⋯」。每晚：active 日記 > 12 篇的配對，
// 最舊 8 篇 → LLM 寫一篇第一人稱沉澱（source='digest'）→ 原件 archived＋digestedInto 可溯。
// 分工守天條：挑選、計數、標記全程式；LLM 只寫沉澱文字。

const DIGEST_TRIGGER = 12;  // active 篇數超過這個才沉澱
const DIGEST_BATCH = 8;     // 一次吸收最舊幾篇

export async function consolidateDiaries(
  db: Firestore,
  client: LLMClient,
  opts: { timeBudgetMs?: number } = {},
): Promise<{ pairs: number; digested: number }> {
  const startedAt = Date.now();
  const budget = opts.timeBudgetMs ?? 60_000;
  let pairs = 0, digested = 0;

  const relSnap = await db.collection(COL.relationships).limit(500).get();
  for (const relDoc of relSnap.docs) {
    if (Date.now() - startedAt > budget) break;
    const rel = relDoc.data() as { userId: string; characterId: string };

    // 用既有 DESC 複合索引（diary userId+characterId+createdAt DESC），程式反轉成舊→新
    const snap = await db.collection(COL.diary)
      .where('userId', '==', rel.userId)
      .where('characterId', '==', rel.characterId)
      .orderBy('createdAt', 'desc')
      .get();
    const active = snap.docs.filter(d => ((d.data() as DiaryDoc).status ?? 'active') === 'active').reverse();
    if (active.length <= DIGEST_TRIGGER) continue;
    pairs++;

    const batch = active.slice(0, DIGEST_BATCH);
    const entries = batch.map(d => d.data() as DiaryDoc);
    const listing = entries.map(e =>
      `（${relativeTime(e.createdAt as FirebaseFirestore.Timestamp | Date)}）${e.entry}`
    ).join('\n');

    try {
      const res = await client.messages.create({
        model: DIARY_MODEL,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `這是你過去一段時間寫的幾篇日記：

${listing}

現在你回頭讀這段日子，把它們沉澱成一段話（100-150字，第一人稱）——不是摘要，是「那段時間的我在想什麼、有什麼在慢慢變化」。保留還沒放下的事。

只回 JSON：
<result>
{"entry": "...", "mood": "..."}
</result>`,
        }],
      });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
      const match = text.match(/<result>([\s\S]*?)<\/result>/);
      const parsed = match ? parseJsonLoose<{ entry?: string; mood?: string }>(match[1].trim()) : null;
      if (!parsed?.entry?.trim()) continue;

      // 未消化的 unspoken/nextTime 由程式原樣繼承（不能讓 LLM 沉澱掉「還掛著的事」）
      const carryUnspoken = entries.flatMap(e => e.unspoken || []).slice(-MAX_UNSPOKEN);
      const carryNextTime = entries.flatMap(e => e.nextTime || []).slice(-MAX_NEXT_TIME);

      const digestRef = db.collection(COL.diary).doc();
      await digestRef.set({
        userId: rel.userId,
        characterId: rel.characterId,
        entry: parsed.entry.trim().slice(0, MAX_ENTRY_CHARS),
        unspoken: carryUnspoken,
        nextTime: carryNextTime,
        mood: (parsed.mood || '').trim().slice(0, 20),
        source: 'digest',
        status: 'active',
        createdAt: entries[entries.length - 1].createdAt, // 沉澱篇掛在被吸收段落的時間軸位置
      } as DiaryDoc);
      for (const d of batch) {
        await d.ref.update({ status: 'archived', digestedInto: digestRef.id });
      }
      digested++;
      console.info(`[diary-digest] ${rel.userId}×${rel.characterId}: ${batch.length} 篇 → 1 篇沉澱`);
    } catch (e) {
      console.error('[diary-digest] failed（跳過此配對）:', e instanceof Error ? e.message : String(e));
    }
  }
  return { pairs, digested };
}
