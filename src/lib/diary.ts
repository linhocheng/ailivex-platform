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

    const entries = snap.docs.map(d => d.data() as DiaryDoc).reverse(); // 舊→新
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
