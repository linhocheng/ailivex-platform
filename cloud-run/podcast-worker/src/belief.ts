/**
 * L1 素材層＋L2 靈魂層前置生成
 *
 * corpus 掛既有角色知識庫：knowledge_docs(active) → knowledge_chunks，
 * evidence_refs 指向 chunk id，sectionRef 可回溯出處。庫是空的就是空的——
 * 該角色所有案例只能講「假設一個情境」（R4 會擋），不無中生有。
 *
 * Belief State 輕量路線（Adam 拍板）：job 內從 soul＋目標自動生成，
 * 寫進 task doc 留底可查，不加人工確認閘。
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type BeliefState, type CorpusEntry, type DuoChar, type BridgeCall,
  DUO_MODEL, extractJson,
} from './duo-types.js';

const CORPUS_CAP = 60; // 進 prompt 的條目上限（Tracy 級 36 條全進，超大庫截斷並 log）

export async function loadCorpus(db: Firestore, characterId: string): Promise<CorpusEntry[]> {
  const docs = await db.collection('knowledge_docs')
    .where('characterId', '==', characterId)
    .where('status', '==', 'active')
    .get();
  const titleById = new Map<string, string>();
  docs.docs.forEach(d => titleById.set(d.id, (d.data().title as string) ?? '未命名'));
  if (titleById.size === 0) return [];

  const chunks = await db.collection('knowledge_chunks')
    .where('characterId', '==', characterId)
    .get();
  const entries: CorpusEntry[] = [];
  for (const c of chunks.docs) {
    const k = c.data() as { documentId: string; content: string; gist?: string; sectionRef: string; authority: string };
    if (!titleById.has(k.documentId)) continue; // 母表非 active 的塊不進 corpus
    entries.push({
      id: c.id,
      title: titleById.get(k.documentId)!,
      excerpt: (k.gist || k.content || '').slice(0, 80),
      sectionRef: k.sectionRef ?? '',
      authority: k.authority ?? 'derived',
    });
  }
  if (entries.length > CORPUS_CAP) {
    console.warn(`[duo] corpus ${characterId} ${entries.length} 條超過上限，截斷至 ${CORPUS_CAP}（canonical 優先）`);
    entries.sort((a, b) => (a.authority === 'canonical' ? -1 : 0) - (b.authority === 'canonical' ? -1 : 0));
    entries.length = CORPUS_CAP;
  }
  return entries;
}

export function corpusMenu(corpus: CorpusEntry[]): string {
  if (corpus.length === 0) {
    return '（你的素材庫是空的。這意味著：你不可以講任何「我有一個學員」「我帶過一個案子」式的真實案例。要舉例只能明說「假設一個情境：⋯⋯」。）';
  }
  return corpus.map(e => `- ${e.id}｜${e.title}｜${e.sectionRef}｜${e.excerpt}`).join('\n');
}

/** 開錄前生成四欄 Belief State；兩次重生成都壞 → 整集 fail（誠實，不硬上） */
export async function generateBelief(
  bridgeCall: BridgeCall,
  char: DuoChar,
  episodeGoal: string,
  corpus: CorpusEntry[],
): Promise<BeliefState> {
  const system = `你是${char.name}。以下是你完整的角色意識、價值觀、思考方式：

${(char.soulCore || char.soul).slice(0, 2000)}

你即將參加一場雙人對話，這一集要回答：「${episodeGoal}」

在開錄前，你必須誠實填寫你的立場狀態。這不是修辭練習——WEAKEST_POINT 是你真實的軟肋，對方有權攻打它，你不得閃躲。兩個 100% 確信的人只能對撞，不能對話。

你的素材庫標題：${corpus.length ? [...new Set(corpus.map(e => e.title))].join('、') : '（空）'}

輸出純 JSON（不加 markdown）：
{"coreClaim":"核心主張，一句話不超過25字","weakestPoint":"我最沒把握的一點，具體","whatWouldChangeMe":"什麼證據會讓我改變想法——要具體到像一個實驗，禁止寫「有力的證據」這種空話","outOfScope":"超出我專業、我不談的領域"}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await bridgeCall(DUO_MODEL, system, '請填寫你的立場狀態。', 400);
    const p = extractJson<BeliefState>(raw);
    if (p && p.coreClaim?.trim() && p.weakestPoint?.trim() && p.whatWouldChangeMe?.trim() && p.outOfScope?.trim()) {
      return {
        coreClaim: p.coreClaim.trim().slice(0, 60),
        weakestPoint: p.weakestPoint.trim(),
        whatWouldChangeMe: p.whatWouldChangeMe.trim(),
        outOfScope: p.outOfScope.trim(),
      };
    }
    console.warn(`[duo] belief ${char.name} 第 ${attempt + 1} 次生成不合格，重生成`);
  }
  throw new Error(`${char.name} 的 Belief State 生成失敗（3 次），本集中止`);
}
