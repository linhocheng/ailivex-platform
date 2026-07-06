/**
 * 文字過濾器 — 可程式化的編輯部風格手冊（唯一真相源）
 *
 * 兩層分工（確定性用程式）：
 *   第一層：句型 pattern 掃描（程式，100% 確定，回報位置供 UI 標記）
 *   第二層：LLM 只改寫踩雷句（「找出背後的具體事件，直說」），其他字不動
 *
 * 兩種使用模式（依出口決定）：
 *   自動改寫 — 出口是機器（口播稿→TTS、podcast→音檔），沒有人再看一眼
 *   標記給人 — 出口是編輯（懶人包文案、圖卡文字），把問題照亮，改不改編輯決定
 *
 * 詞庫分類：ai-flavor（AI 慣性句型）/ clickbait（農場詞）/ style-guide（自家用字慣例）
 * Firestore `config/textFilter` 可擴充（patterns: [{id, regex, note, category, enabled}]），
 * 同 id 覆蓋內建；enabled:false 可關掉內建條目。
 */
import type { Firestore } from 'firebase-admin/firestore'

export type FilterCategory = 'ai-flavor' | 'clickbait' | 'style-guide'

export interface FilterPattern {
  id: string
  regex: string
  note: string
  category: FilterCategory
  enabled?: boolean
}

export interface FilterHit {
  patternId: string
  matched: string
  index: number
  note: string
  category: FilterCategory
}

export const DEFAULT_PATTERNS: FilterPattern[] = [
  // ── ai-flavor：抓「抽象主語 + 體感動詞」的模式，不抓單字（「螺絲鬆了」是正常人話）──
  {
    id: 'somatic-abstract',
    regex: '(好像|彷彿|似乎)?(心裡|心中|胸口|身體裡)?(有)?(什麼|什麽|某個地方|某處|一些東西|什麼東西)(在)?[^，。！？]{0,4}(鬆|松|緊|沉|輕|重|軟|暖|裂|碎)(了|開)(一點|一下|一些|些許)?',
    note: '抽象體感：好像有什麼鬆了一下',
    category: 'ai-flavor',
  },
  {
    id: 'somatic-heart',
    regex: '心(裡|中)(某個地方|深處|有個地方)(被)?[^，。！？]{0,6}(動|軟|暖|鬆|緊|沉)了(一下|一點)?',
    note: '心裡某個地方動了一下',
    category: 'ai-flavor',
  },
  {
    id: 'unnamable-feeling',
    regex: '(某種|一種)(說不清|說不上來|難以名狀|難以言喻|無法言說)(楚)?的(情緒|感覺|東西|什麼)',
    note: '某種說不清的情緒',
    category: 'ai-flavor',
  },
  {
    id: 'flash-of',
    regex: '(閃過|掠過|湧起|泛起|升起)(一絲|一抹|一股)[^，。！？]{1,8}',
    note: '閃過一絲＿＿',
    category: 'ai-flavor',
  },
  {
    id: 'air-freezes',
    regex: '(空氣|時間)(突然|彷彿|好像)?(凝固|靜止|停(了|住)|慢了下來)',
    note: '空氣凝固／時間靜止',
    category: 'ai-flavor',
  },
  {
    id: 'words-heavy',
    regex: '(這|那)(句話|個字|兩個字|幾個字)(很|太|好)(重|沉|輕)',
    note: '這句話很重',
    category: 'ai-flavor',
  },
  {
    id: 'something-lands',
    regex: '(什麼|什麽|有些東西)(落|降落|安放|安頓)(了)?(下來)',
    note: '有什麼落了下來',
    category: 'ai-flavor',
  },
  {
    id: 'spatial-interrogate',
    regex: '(往|向|再往)前[^，。！？]{0,4}(追|逼|推)(問|问)?(你|妳|您)',
    note: '往前一步追你——空間隱喻語意含混，說清楚：是多說、多問、還是追問',
    category: 'ai-flavor',
  },
  // ── clickbait：農場詞（新聞編輯台禁用清單的程式化）──────────────────────
  {
    id: 'shocking',
    regex: '震驚(了)?(所有人|全網|各界)?|驚呆(了)?|嚇壞(了)?(網友|眾人)?',
    note: '農場詞：震驚／驚呆',
    category: 'clickbait',
  },
  {
    id: 'netizens-buzz',
    regex: '網友(熱議|瘋傳|炸鍋|暴動|嗨翻|直呼)',
    note: '農場詞：網友熱議／瘋傳',
    category: 'clickbait',
  },
  {
    id: 'xiaobian',
    regex: '小編',
    note: '農場詞：小編',
    category: 'clickbait',
  },
  {
    id: 'must-read',
    regex: '(必看|必收藏|看完(秒懂|跪了)|一篇搞懂|懶人包必備)',
    note: '農場詞：必看／秒懂',
    category: 'clickbait',
  },
]

export interface CompiledPattern {
  id: string
  re: RegExp
  note: string
  category: FilterCategory
}

export function compilePatterns(patterns: FilterPattern[]): CompiledPattern[] {
  const out: CompiledPattern[] = []
  for (const p of patterns) {
    if (p.enabled === false) continue
    try {
      out.push({ id: p.id, re: new RegExp(p.regex, 'g'), note: p.note, category: p.category })
    } catch {
      console.warn(`[text-filter] bad regex skipped: ${p.id}`)
    }
  }
  return out
}

export async function loadPatterns(db: Firestore): Promise<CompiledPattern[]> {
  const merged = new Map(DEFAULT_PATTERNS.map(p => [p.id, p]))
  try {
    const snap = await db.collection('config').doc('textFilter').get()
    const extra = (snap.data()?.patterns ?? []) as FilterPattern[]
    for (const p of extra) {
      if (p?.id && typeof p.regex === 'string') merged.set(p.id, p)
    }
  } catch {
    // Firestore 讀不到就用內建，不擋生成
  }
  return compilePatterns([...merged.values()])
}

export function scanText(text: string, patterns: CompiledPattern[]): FilterHit[] {
  const hits: FilterHit[] = []
  for (const { id, re, note, category } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      hits.push({ patternId: id, matched: m[0], index: m.index, note, category })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/**
 * LLM 改寫：只改含踩雷片語的句子，其他一個字不動。
 * characterPrompt 給了就保角色語氣，沒給就用中性編輯語氣。
 */
export async function rewriteFlagged(
  text: string,
  hits: FilterHit[],
  bridgeEndpoint: string,
  bridgeSecret: string,
  characterPrompt?: string,
): Promise<string> {
  if (hits.length === 0) return text
  const hitList = [...new Set(hits.map(h => `「${h.matched}」（${h.note}）`))].join('、')
  const voiceNote = characterPrompt
    ? `這段文字出自以下角色，改寫要保持他的語氣：\n\n${characterPrompt.slice(0, 800)}\n\n`
    : '用自然的新聞編輯語感改寫，不加華麗修辭。\n\n'

  const res = await fetch(bridgeEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': bridgeSecret },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: Math.min(4000, Math.ceil(text.length * 2)),
      system: `你是文字修訂者。${voiceNote}以下文字裡有這些不該出現的表達：${hitList}。

抽象體感詞（鬆／緊／重）的背後一定有一個具體的事件——找出它真正想說的事，直說出來。
農場詞直接刪掉或改成平實的說法。

你的任務：只改寫含這些片語的句子，其他句子一個字都不准動。
只輸出改寫後的完整文字，不加任何說明。`,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`rewrite bridge ${res.status}`)
  const d = await res.json() as { content?: Array<{ text: string }> }
  const out = (d.content?.[0]?.text ?? '').trim()
  return out || text
}
