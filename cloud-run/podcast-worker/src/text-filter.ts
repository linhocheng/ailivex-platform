/**
 * 文字過濾器 — 擋 AI 味句型（「好像有什麼鬆了一下」類）
 *
 * 兩層分工（天條：確定性用程式）：
 *   第一層：句型 pattern 掃描（程式，100% 確定）
 *   第二層：LLM 只重寫踩雷句，指令＝「找出背後的具體事件，用角色的話直說」
 *
 * 詞庫可從 Firestore config/podcastTextFilter 擴充（patterns: [{id, regex, note, enabled}]），
 * 與內建 DEFAULT_PATTERNS 合併；Firestore 同 id 覆蓋內建（enabled:false 可關掉內建條目）。
 */
import type { Firestore } from 'firebase-admin/firestore';

export interface FilterPattern {
  id: string;
  regex: string;
  note: string;
  enabled?: boolean;
}

export interface FilterHit {
  patternId: string;
  matched: string;
}

// 內建句型庫：抓「抽象主語 + 體感動詞」的模式，不抓單字（「螺絲鬆了」是正常人話）
export const DEFAULT_PATTERNS: FilterPattern[] = [
  {
    id: 'somatic-abstract',
    regex: '(好像|彷彿|似乎)?(心裡|心中|胸口|身體裡)?(有)?(什麼|什麽|某個地方|某處|一些東西|什麼東西)(在)?[^，。！？]{0,4}(鬆|松|緊|沉|輕|重|軟|暖|裂|碎)(了|開)(一點|一下|一些|些許)?',
    note: '抽象體感：好像有什麼鬆了一下',
  },
  {
    id: 'somatic-heart',
    regex: '心(裡|中)(某個地方|深處|有個地方)(被)?[^，。！？]{0,6}(動|軟|暖|鬆|緊|沉)了(一下|一點)?',
    note: '心裡某個地方動了一下',
  },
  {
    id: 'unnamable-feeling',
    regex: '(某種|一種)(說不清|說不上來|難以名狀|難以言喻|無法言說)(楚)?的(情緒|感覺|東西|什麼)',
    note: '某種說不清的情緒',
  },
  {
    id: 'flash-of',
    regex: '(閃過|掠過|湧起|泛起|升起)(一絲|一抹|一股)[^，。！？]{1,8}',
    note: '閃過一絲＿＿',
  },
  {
    id: 'air-freezes',
    regex: '(空氣|時間)(突然|彷彿|好像)?(凝固|靜止|停(了|住)|慢了下來)',
    note: '空氣凝固／時間靜止',
  },
  {
    id: 'words-heavy',
    regex: '(這|那)(句話|個字|兩個字|幾個字)(很|太|好)(重|沉|輕)',
    note: '這句話很重',
  },
  {
    id: 'something-lands',
    regex: '(什麼|什麽|有些東西)(落|降落|安放|安頓)(了)?(下來)',
    note: '有什麼落了下來',
  },
  {
    id: 'spatial-interrogate',
    regex: '(往|向|再往)前[^，。！？]{0,4}(追|逼|推)(問|问)?(你|妳|您)',
    note: '往前一步追你——空間隱喻語意含混，說清楚：是多說、多問、還是追問（2026-07-06）',
  },
];

export function compilePatterns(patterns: FilterPattern[]): Array<{ id: string; re: RegExp }> {
  const out: Array<{ id: string; re: RegExp }> = [];
  for (const p of patterns) {
    if (p.enabled === false) continue;
    try {
      out.push({ id: p.id, re: new RegExp(p.regex, 'g') });
    } catch {
      console.warn(`[text-filter] bad regex skipped: ${p.id}`);
    }
  }
  return out;
}

export async function loadPatterns(db: Firestore): Promise<Array<{ id: string; re: RegExp }>> {
  const merged = new Map(DEFAULT_PATTERNS.map(p => [p.id, p]));
  try {
    const snap = await db.collection('config').doc('podcastTextFilter').get();
    const extra = (snap.data()?.patterns ?? []) as FilterPattern[];
    for (const p of extra) {
      if (p?.id && typeof p.regex === 'string') merged.set(p.id, p);
    }
  } catch {
    // Firestore 讀不到就用內建，不擋生成
  }
  return compilePatterns([...merged.values()]);
}

export function scanText(text: string, patterns: Array<{ id: string; re: RegExp }>): FilterHit[] {
  const hits: FilterHit[] = [];
  for (const { id, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ patternId: id, matched: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}

/**
 * 過濾一句台詞：踩雷 → LLM 錨定事件改寫（只改踩雷處）→ 複掃。
 * 改寫後仍踩雷就收改寫版（盡力而為，log 留痕），不無限重試。
 */
export async function filterLine(
  text: string,
  characterName: string,
  soulExcerpt: string,
  recentContext: string,
  patterns: Array<{ id: string; re: RegExp }>,
  bridgeCall: (model: string, system: string, user: string, maxTokens: number) => Promise<string>,
): Promise<{ text: string; hits: FilterHit[] }> {
  const hits = scanText(text, patterns);
  if (hits.length === 0) return { text, hits };

  const hitList = hits.map(h => `「${h.matched}」`).join('、');
  try {
    const rewritten = await bridgeCall(
      'claude-sonnet-4-6',
      `你是台詞修訂者。以下台詞出自角色「${characterName}」：

${soulExcerpt}

這句台詞裡有 AI 味的抽象體感表達：${hitList}。
人不會這樣說話——這種「鬆／緊／重」的感受背後，一定有一個具體的事件或行為。

你的任務：只改寫踩雷的那幾個字，找出它背後想說的具體事件，用這個角色自己的話直說出來。
台詞的其他部分一個字都不准動。保持角色語氣。

只輸出改寫後的完整台詞，不加任何說明。`,
      `對話脈絡：
${recentContext || '（無）'}

原台詞：${text}`,
      300,
    );
    const clean = rewritten.trim().replace(/^\[.*?\][:：]\s*/, '');
    if (!clean) return { text, hits };
    const residual = scanText(clean, patterns);
    if (residual.length > 0) {
      console.warn(`[text-filter] residual after rewrite (${characterName}): ${residual.map(h => h.matched).join('、')}`);
    }
    return { text: clean, hits };
  } catch (err) {
    console.warn(`[text-filter] rewrite failed, keep original: ${err instanceof Error ? err.message : err}`);
    return { text, hits };
  }
}
