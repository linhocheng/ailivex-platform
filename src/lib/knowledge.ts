/**
 * 知識庫（著作層）—— 角色「寫過/講過什麼」（2026-07-08）。
 *
 * 核心律令：同一個事實只有一個權威來源。角色不亂編靠的不是知道更多，
 * 是清楚知道自己不知道什麼——τ 門檻撈不到就整塊不注入，寧可空手不硬湊。
 *
 * 分工守天條：切塊/embedding/計分/門檻/計數全是程式；LLM 只在對話裡引用。
 * 相容開關：character.knowledgeChunkCount 缺省/0 → loadKnowledgeBlock 直接回空字串，
 * 沒設知識庫的角色連檢索路徑都不走（零延遲、零讀取、行為與既有完全一致）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  COL,
  type CharacterDoc,
  type KnowledgeDocDoc,
  type KnowledgeChunkDoc,
  type KnowledgeDocType,
  type KnowledgeAuthority,
} from '@/lib/collections';
import { generateKnowledgeEmbedding, cosineSimilarity } from '@/lib/embeddings';

// ── 檢索參數 ──────────────────────────────────────────────────────────────────
const KNOWLEDGE_TOP_K = 3;
const KNOWLEDGE_FLOOR = 0.68;   // τ：cosine 低於此不得當事實注入（multilingual-002 實測：相關0.79/擦邊0.66/無關0.54）
const KNOWLEDGE_LEX_RESCUE = 0.25; // 詞彙重疊夠高也可入選——用戶逐字引原句（「其疾如風」）是最強信號，
                                  // 且 query 的閒聊 bigram（是什/意思）幾乎不會出現在文本裡，誤放行風險低
const MAX_POOL = 2000;          // 程式端 cosine 的池子上限（超過要升向量索引）
const SMALL_DOC_CHUNKS = 6;     // 文件總塊數 ≤ 此值時，命中即整份帶入（定義/清單類內容不能殘缺）
const SIBLING_CAP = 8;          // 兄弟塊補帶的總量上限（防 prompt 爆量）

// ── 切塊參數（確定性，無 LLM）─────────────────────────────────────────────────
const CHUNK_TARGET = 500;  // 目標塊長（字元）
const CHUNK_MAX = 900;     // 硬上限，超過按句切

export const AUTHORITY_LABELS: Record<KnowledgeAuthority, string> = {
  canonical: '本人原話',
  paraphrase: '轉述',
  derived: '整理',
};

// ─── 切塊：段落合併到目標長度，超長段按句切 ───────────────────────────────────

export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_MAX) { units.push(p); continue; }
    // 超長段：按中文句號/驚嘆/問號切再合併
    const sentences = p.match(/[^。！？!?]+[。！？!?]*/g) ?? [p];
    let buf = '';
    for (const s of sentences) {
      if (buf && (buf + s).length > CHUNK_MAX) { units.push(buf); buf = s; }
      else buf += s;
    }
    if (buf) units.push(buf);
  }

  // 相鄰短段合併到目標長度
  const chunks: string[] = [];
  let buf = '';
  for (const u of units) {
    if (buf && (buf + '\n' + u).length > CHUNK_TARGET) { chunks.push(buf); buf = u; }
    else buf = buf ? buf + '\n' + u : u;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ─── 白話大意（檢索索引）───────────────────────────────────────────────────────
// 為什麼：單一主題語料庫內 cosine 坍縮（孫子兵法 27 塊全擠 0.74-0.78，白話問句
// 撈文言原文排到 #15）。大意與 query 同語域後目標塊升 #1（實測 0.797 vs 0.759）。
// 分工守天條：LLM 只寫大意（生成）；批次、驗證、fallback、嵌入全程式。

const GIST_MODEL = 'claude-sonnet-4-6';
const GIST_BATCH = 8;

type LLMClient = {
  messages: {
    create: (args: {
      model: string; max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

async function generateGists(chunks: string[], client: LLMClient): Promise<(string | null)[]> {
  const { parseJsonLoose } = await import('@/lib/safe-json');
  const gists: (string | null)[] = new Array(chunks.length).fill(null);

  const batchStarts: number[] = [];
  for (let i = 0; i < chunks.length; i += GIST_BATCH) batchStarts.push(i);

  let cursor = 0;
  async function worker() {
    while (cursor < batchStarts.length) {
      const start = batchStarts[cursor++];
      const batch = chunks.slice(start, start + GIST_BATCH);
      const listing = batch.map((c, i) => `${i + 1}. ${c}`).join('\n\n');
      try {
        const res = await client.messages.create({
          model: GIST_MODEL,
          max_tokens: 300 * batch.length + 300,
          messages: [{
            role: 'user',
            content: `把以下每段原文各寫成 40-100 字的繁體中文白話大意。這是檢索索引，用途是讓一般人的日常提問能對上這段內容，所以：
- 完全用現代日常口語，不保留文言詞句——古語要翻成大白話（例：「不戰而屈人之兵」→「不用開打就讓敵人屈服投降」）
- 不要每條都用同樣的開頭（不要都寫「孫子說」），直接講這段獨有的主張
- 突出這段最核心、別段沒有的關鍵概念，人名與專有名詞保留

${listing}

只回 JSON 字串陣列，長度必須是 ${batch.length}：
<result>
["大意1", "大意2"]
</result>`,
          }],
        });
        const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
        // 寬容解析（程式級 repair，不 re-ask 模型）：<result> → ```json 圍欄 → 裸陣列
        const m = text.match(/<result>([\s\S]*?)<\/result>/)
          ?? text.match(/```(?:json)?\s*([\s\S]*?)```/)
          ?? text.match(/(\[[\s\S]*\])/);
        let arr = m ? parseJsonLoose<string[] | { result?: string[] }>(m[1].trim()) : null;
        // 模型偶爾包成 {"result":[...]} —— 程式接住，不 re-ask
        if (arr && !Array.isArray(arr) && Array.isArray((arr as { result?: string[] }).result)) {
          arr = (arr as { result: string[] }).result;
        }
        if (Array.isArray(arr)) {
          for (let i = 0; i < batch.length; i++) {
            const g = typeof arr[i] === 'string' ? arr[i].trim() : '';
            if (g) gists[start + i] = g.slice(0, 200);
          }
        } else {
          console.warn('[knowledge] gist batch 輸出無法解析（該批 fallback 原文嵌入）:', text.slice(0, 120));
        }
      } catch (e) {
        console.error('[knowledge] gist batch failed（該批 fallback 原文嵌入）:', e instanceof Error ? e.message : String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return gists;
}

// ─── 入庫：建母表 → 切塊 → 白話大意 → embedding（併發 4）→ 批次寫 → 維護計數 ──

export async function ingestKnowledgeDoc(
  db: Firestore,
  characterId: string,
  input: {
    title: string;
    docType: KnowledgeDocType;
    authority: KnowledgeAuthority;
    sourceRef?: string;
    content: string;
    /** 可選：預寫檢索索引（時機地址——「這塊在什麼時刻該浮出來」的編輯決策）。
     *  長度必須 === chunkText(content).length（呼叫端先用 chunkText 對齊）；
     *  null 元素該塊 fallback 原文嵌入。不傳則維持原行為（client 自動生成內容大意）。 */
    gists?: (string | null)[];
  },
  client?: LLMClient,  // 有 client 才做白話大意索引；沒有直接嵌原文（向下相容）
): Promise<{ documentId: string; chunkCount: number }> {
  const chunks = chunkText(input.content);
  if (chunks.length === 0) throw new Error('內容切塊後為空');

  // 索引解析順序：預寫 gists → client 自動生成 → 無（嵌原文）。
  // 預寫長度錯位寧可炸不靜默——錯位的索引比沒有索引更毒（撈到不相干的塊）。
  let gists: (string | null)[];
  if (input.gists) {
    if (input.gists.length !== chunks.length) {
      throw new Error(`gists 長度 ${input.gists.length} ≠ 切塊數 ${chunks.length}（先用 chunkText(content) 對齊再入庫）`);
    }
    gists = input.gists.map(g => (g && g.trim() ? g.trim().slice(0, 200) : null));
  } else {
    // 白話大意（失敗的塊 fallback 原文嵌入，不擋入庫）
    gists = client ? await generateGists(chunks, client) : new Array(chunks.length).fill(null);
  }

  // embedding 併發 4（有大意嵌大意，同語域才對得上白話 query；失敗的塊照存）
  const embeddings: (number[] | null)[] = new Array(chunks.length).fill(null);
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const i = cursor++;
      embeddings[i] = await generateKnowledgeEmbedding(gists[i] ?? chunks[i], 'document').catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  const docRef = db.collection(COL.knowledgeDocs).doc();
  const docRow: KnowledgeDocDoc = {
    characterId,
    title: input.title.trim(),
    docType: input.docType,
    authority: input.authority,
    ...(input.sourceRef?.trim() ? { sourceRef: input.sourceRef.trim() } : {}),
    chunkCount: chunks.length,
    status: 'active',
    createdAt: new Date(),
  };

  // Firestore batch 上限 500 → 分批
  const batches: FirebaseFirestore.WriteBatch[] = [];
  let batch = db.batch();
  batch.set(docRef, docRow);
  let ops = 1;
  chunks.forEach((content, i) => {
    if (ops >= 450) { batches.push(batch); batch = db.batch(); ops = 0; }
    const row: KnowledgeChunkDoc = {
      characterId,
      documentId: docRef.id,
      content,
      ...(gists[i] ? { gist: gists[i]! } : {}),
      ...(embeddings[i] ? { embedding: embeddings[i]! } : {}),
      sectionRef: `第${i + 1}段`,
      authority: input.authority,
      order: i,
      createdAt: new Date(),
    };
    batch.set(db.collection(COL.knowledgeChunks).doc(), row);
    ops++;
  });
  batches.push(batch);
  for (const b of batches) await b.commit();

  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection(COL.characters).doc(characterId)
    .update({ knowledgeChunkCount: FieldValue.increment(chunks.length) });

  return { documentId: docRef.id, chunkCount: chunks.length };
}

// ─── 刪除：清 chunks → 刪母表 → 計數遞減 ──────────────────────────────────────

export async function deleteKnowledgeDoc(
  db: Firestore,
  characterId: string,
  documentId: string,
): Promise<{ deletedChunks: number }> {
  const chunkSnap = await db.collection(COL.knowledgeChunks)
    .where('documentId', '==', documentId)
    .get();

  let batch = db.batch();
  let ops = 0;
  let deleted = 0;
  for (const d of chunkSnap.docs) {
    batch.delete(d.ref);
    deleted++;
    if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  batch.delete(db.collection(COL.knowledgeDocs).doc(documentId));
  await batch.commit();

  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection(COL.characters).doc(characterId)
    .update({ knowledgeChunkCount: FieldValue.increment(-deleted) })
    .catch(() => {});

  return { deletedChunks: deleted };
}

// ─── 讀：檢索 → τ 門檻 → 組塊（撈不到回空字串 = 不注入）──────────────────────

/** query → 詞項（與 memory.ts 同法：CJK bigram + 拉丁整詞）*/
function lexTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const w of query.match(/[a-zA-Z0-9]{2,}/g) ?? []) terms.add(w.toLowerCase());
  const cjk = query.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk[i] + cjk[i + 1]);
  return [...terms];
}

function lexOverlap(terms: string[], content: string): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let hit = 0;
  for (const t of terms) if (lower.includes(t)) hit++;
  return hit / terms.length;
}

/**
 * 組知識塊。char 傳入角色 doc（每輪本來就讀了）——knowledgeChunkCount 缺省/0 直接空手回家。
 * 回傳空字串 = 這條路徑對這輪對話完全不存在。
 */
export async function loadKnowledgeBlock(
  db: Firestore,
  characterId: string,
  query: string,
  char?: Pick<CharacterDoc, 'knowledgeChunkCount'>,
): Promise<string> {
  if (!characterId || !query?.trim()) return '';
  if (!char?.knowledgeChunkCount || char.knowledgeChunkCount <= 0) return '';

  try {
    const [qEmb, snap] = await Promise.all([
      generateKnowledgeEmbedding(query, 'query').catch(() => null),
      db.collection(COL.knowledgeChunks)
        .where('characterId', '==', characterId)
        .limit(MAX_POOL)
        .get(),
    ]);
    if (snap.empty) return '';

    const docTitles = new Map<string, string>();
    const qTerms = lexTerms(query);

    const scored = snap.docs
      .map(d => d.data() as KnowledgeChunkDoc)
      .map(c => {
        const cos = qEmb && Array.isArray(c.embedding) && c.embedding.length > 0
          ? cosineSimilarity(qEmb, c.embedding as number[]) : 0;
        // 原文與白話大意都算詞彙重疊（引原文詞打原文、講白話打大意）
        const lex = Math.max(lexOverlap(qTerms, c.content ?? ''), lexOverlap(qTerms, c.gist ?? ''));
        return { c, cos, lex, score: cos * 0.7 + lex * 0.3 };
      })
      // τ 是護城河：語義夠高，或詞彙直中（專有名詞救援），否則寧可空手
      .filter(x => x.cos >= KNOWLEDGE_FLOOR || x.lex >= KNOWLEDGE_LEX_RESCUE)
      .sort((a, b) => b.score - a.score)
      .slice(0, KNOWLEDGE_TOP_K);

    if (scored.length === 0) return '';

    // 小文件整份帶入：top-K 命中某文件、且該文件總塊數 ≤ SMALL_DOC_CHUNKS 時，
    // 把缺席的兄弟塊一併帶入。定義/清單類內容（如「換框八法」）常橫跨多塊，
    // 只帶命中塊會讓角色只拿到清單的一半——寧可多幾百字也不能讓專業內容殘缺。
    const byDoc = new Map<string, KnowledgeChunkDoc[]>();
    for (const d of snap.docs) {
      const c = d.data() as KnowledgeChunkDoc;
      const arr = byDoc.get(c.documentId);
      if (arr) arr.push(c); else byDoc.set(c.documentId, [c]);
    }
    const inScored = new Set(scored.map(x => x.c));
    const siblings: KnowledgeChunkDoc[] = [];
    for (const docId of new Set(scored.map(x => x.c.documentId))) {
      const all = byDoc.get(docId) ?? [];
      if (all.length === 0 || all.length > SMALL_DOC_CHUNKS) continue;
      for (const c of all) {
        if (!inScored.has(c) && siblings.length < SIBLING_CAP) siblings.push(c);
      }
    }
    siblings.sort((a, b) =>
      (parseInt(a.sectionRef.match(/\d+/)?.[0] ?? '0', 10)) - (parseInt(b.sectionRef.match(/\d+/)?.[0] ?? '0', 10)));

    // 補母表標題（出處要人話：書名＋段落）
    const docIds = [...new Set([...scored.map(x => x.c.documentId), ...siblings.map(c => c.documentId)])];
    await Promise.all(docIds.map(async id => {
      const s = await db.collection(COL.knowledgeDocs).doc(id).get().catch(() => null);
      if (s?.exists) docTitles.set(id, (s.data() as KnowledgeDocDoc).title);
    }));

    const lines = [...scored.map(x => x.c), ...siblings].map(c => {
      const title = docTitles.get(c.documentId) || '未知出處';
      return `〔${title}·${c.sectionRef}｜${AUTHORITY_LABELS[c.authority] ?? c.authority}〕${c.content}`;
    });

    // 三態區分規則跟著塊走（只在有知識時注入 → 沒知識庫的角色 prompt 一字不多）。
    // 規則只管格式（要分清三態），措辭留給角色的靈魂——不寫死認輸的說法。
    return `\n\n【我寫過/講過的內容——依對方這句話撈出的相關段落】
${lines.map(l => `- ${l}`).join('\n')}
（用的時候分清楚三種話：引用上面內容時，那是你真正寫過/講過的，可以自然指出出處；上面沒有、但你想談自己的看法時，明白說這是你此刻的想法、不是你寫過的內容；如果對方問的東西不在你寫過的範圍、你也沒把握，就用你自己的方式坦白承認，不要編造你沒寫過的主張。另外，上面若含方法、工具、名詞的定義，名稱與內涵以原文為準——不要用自己的話重新定義，也不要把 A 方法的內容講成 B 方法的。）`;
  } catch (e) {
    console.error('[knowledge] loadKnowledgeBlock failed:', e instanceof Error ? e.message : String(e));
    return '';
  }
}

// ── 知識提案（共創閘）────────────────────────────────────────────────────────
// 角色不能自我入庫（會幻覺——Bacha Coffee 曾被記成 1876 咖啡）：
// 提案只落 knowledge_proposals 候選區，admin 審核「轉入庫」才走 ingestKnowledgeDoc 正式管線。

export const KNOWLEDGE_PROPOSAL_MAX_CHARS = 50_000;

/** 只在 admin×共創閘對話注入（與 METHOD_PROPOSE_INSTRUCTION 同閘）。 */
export const KNOWLEDGE_PROPOSE_INSTRUCTION = `
- 知識提案（僅此對話開放）：當訓練師教了你一段值得進知識庫的內容（方法、案例、事實、原文），或明確要你把某段內容提進知識庫時，在回覆中夾帶：
  [[PROPOSE_KNOWLEDGE title="標題"]] 完整內容 [[/PROPOSE_KNOWLEDGE]]
  鐵律：只提「這場對話裡真實出現過的內容」，盡量保留訓練師的原話；不要憑印象補充你不確定的事實、數字、年份、品牌名。
  提案不會立即入庫：訓練師審核通過後才成為你的知識。標記不會顯示給對方，一般聊天不發。`;

export type KnowledgeProposalResult =
  | { ok: true; id: string; title: string }
  | { ok: false; error: string };

export async function saveKnowledgeProposal(
  db: Firestore,
  characterId: string,
  title: string,
  content: string,
  proposedBy: string,
  sourceNote?: string,
): Promise<KnowledgeProposalResult> {
  const t = (title || '').trim();
  const c = (content || '').trim();
  if (!t || !c) return { ok: false, error: 'title / content 缺漏' };
  if (c.length > KNOWLEDGE_PROPOSAL_MAX_CHARS) {
    return { ok: false, error: `內容超過 ${KNOWLEDGE_PROPOSAL_MAX_CHARS} 字上限` };
  }
  // 同標題冪等（僅對未處理的 draft）：同場對話反覆提不灌爆待審區
  const dup = await db.collection(COL.knowledgeProposals)
    .where('characterId', '==', characterId)
    .where('title', '==', t)
    .where('status', '==', 'draft')
    .limit(1).get();
  if (!dup.empty) return { ok: false, error: `已有同標題的待審提案《${t}》` };
  const ref = await db.collection(COL.knowledgeProposals).add({
    characterId,
    title: t,
    content: c,
    ...(sourceNote?.trim() ? { sourceNote: sourceNote.trim() } : {}),
    proposedBy,
    status: 'draft',
    createdAt: new Date(),
  });
  return { ok: true, id: ref.id, title: t };
}
