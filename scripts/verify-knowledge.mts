/**
 * 知識庫＋方法論 e2e 本機驗證（打真 Firestore，測完自清）。
 * 跑法：npx tsx scripts/verify-knowledge.mts
 * （env 由腳本自己 raw 解析 .env.local——FIREBASE_SERVICE_ACCOUNT_JSON 外層引號內含
 *   未跳脫引號，Node --env-file 會在第二個引號截斷，不能用。）
 *
 * 鑑別信號（修好了才會出現）：
 *   K1 chunkText 切塊數與長度上限正確
 *   K2 相關 query → 知識塊注入，含〔出處｜權威度〕與三態規則
 *   K3 無關 query → 空字串（τ 擋住，寧可空手）
 *   K4 沒設知識庫的角色 → 空字串（相容開關）
 *   M1 觸發語 → 遞招塊（含 METHOD_START 說明）
 *   M2 METHOD_START → activeMethodology 寫入 step=1
 *   M3 進行中 → 注入當前步；METHOD_NEXT → step=2
 *   M4 METHOD_EXIT → 狀態清空
 *   T1 parseToolTags 剝乾淨 METHOD 標記
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── env raw 解析（在任何 lib import 之前）──────────────────────────────────────
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const eq = line.indexOf('=');
  if (eq <= 0 || line.startsWith('#')) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (!process.env[key]) process.env[key] = val;
}

const { getFirestore } = await import('../src/lib/firebase-admin');
const { chunkText, ingestKnowledgeDoc, deleteKnowledgeDoc, loadKnowledgeBlock } = await import('../src/lib/knowledge');
const { loadMethodologyBlock, applyMethodologySignals, sanitizeSteps } = await import('../src/lib/methodology');
const { parseToolTags } = await import('../src/lib/tool-tags');
const { COL } = await import('../src/lib/collections');
const { generateKnowledgeEmbedding } = await import('../src/lib/embeddings');
type ActiveMethodologyState = import('../src/lib/collections').ActiveMethodologyState;

const TEST_CHAR = 'zhu-verify-knowledge-tmp';
const TEST_USER = 'zhu-verify-user-tmp';
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

const db = getFirestore();

// ── K1: chunkText 純函數 ──────────────────────────────────────────────────────
const longPara = '這是一句話。'.repeat(200); // 1200 字單段
const chunks = chunkText(`第一段短文。\n\n第二段短文。\n\n${longPara}`);
check('K1 chunkText 有切塊', chunks.length >= 2, `${chunks.length} 塊`);
check('K1 塊長全數 ≤ 900', chunks.every(c => c.length <= 900), `max=${Math.max(...chunks.map(c => c.length))}`);

// ── 建測試角色 ────────────────────────────────────────────────────────────────
await db.collection(COL.characters).doc(TEST_CHAR).set({
  name: '驗證用角色', soul: '測試', avatarUrl: '', status: 'active', createdAt: new Date(),
});

let kdocId = '';
try {
  // ── K2/K3: 入庫 → 檢索 ─────────────────────────────────────────────────────
  const content = `葡萄酒的單寧主要來自葡萄皮與橡木桶，紅酒浸皮時間越長單寧越厚重，這是我在書裡反覆強調的核心觀念。

品飲波爾多左岸的赤霞珠時，先聞黑醋栗與雪松氣息，入口注意單寧的顆粒感與酸度的支撐。

侍酒溫度是最被低估的變因：重酒體紅酒 16-18 度，白酒 8-12 度，香檳 6-8 度。溫度錯了，再好的酒都走樣。`;

  const r = await ingestKnowledgeDoc(db, TEST_CHAR, {
    title: '測試品酒手冊', docType: 'book', authority: 'canonical', sourceRef: '驗證用', content,
  });
  kdocId = r.documentId;
  check('K2 入庫成功', r.chunkCount > 0, `${r.chunkCount} 塊`);

  const charSnap = await db.collection(COL.characters).doc(TEST_CHAR).get();
  const charData = charSnap.data() as { knowledgeChunkCount?: number };
  check('K2 計數開關已寫入', (charData.knowledgeChunkCount ?? 0) === r.chunkCount, `count=${charData.knowledgeChunkCount}`);

  const hit = await loadKnowledgeBlock(db, TEST_CHAR, '紅酒的單寧是從哪裡來的？', charData);
  check('K2 相關 query 撈到塊', hit.includes('單寧'), hit ? `${hit.length} 字` : '空');
  check('K2 塊帶出處與權威度', hit.includes('測試品酒手冊') && hit.includes('本人原話'));
  check('K2 三態規則跟著塊走', hit.includes('坦白承認'));

  const miss = await loadKnowledgeBlock(db, TEST_CHAR, '今天天氣如何要不要帶傘出門', charData);
  check('K3 無關 query 空手（τ 護城河）', miss === '', miss ? `漏水：${miss.slice(0, 60)}` : '');

  const off = await loadKnowledgeBlock(db, TEST_CHAR, '紅酒的單寧是從哪裡來的？', { knowledgeChunkCount: 0 });
  check('K4 開關關閉 → 空手（相容）', off === '');

  // ── M1-M4: 方法論 ──────────────────────────────────────────────────────────
  const steps = sanitizeSteps([
    { instruction: '請對方描述理想中的一天', exitCondition: '對方講出具體畫面' },
    { instruction: '找出畫面中重複出現的元素', exitCondition: '至少點出兩個' },
    { instruction: '把元素連回現在的選項' },
  ]);
  check('M1 sanitizeSteps 驗證通過', !!steps && steps.length === 3 && steps[2].order === 3);

  const trigEmb = await generateKnowledgeEmbedding('用戶對未來方向迷惘、說不清楚自己想要什麼', 'document');
  const mRef = await db.collection(COL.methodologies).add({
    characterId: TEST_CHAR, name: '理想一天引導', purpose: '幫迷惘的人看清自己要什麼',
    triggerDesc: '用戶對未來方向迷惘、說不清楚自己想要什麼', triggerEmb: trigEmb,
    preconditions: ['對方願意聊自己'], steps, status: 'active', createdAt: new Date(),
  });
  await db.collection(COL.characters).doc(TEST_CHAR).update({ methodologyCount: 1 });
  const mChar = { methodologyCount: 1 };

  const offer = await loadMethodologyBlock(db, TEST_CHAR, '我最近好迷惘，完全不知道自己以後要幹嘛', null, mChar);
  check('M1 觸發語 → 遞招', offer.block.includes('METHOD_START') && offer.block.includes('理想一天引導'));

  const noOffer = await loadMethodologyBlock(db, TEST_CHAR, '幫我推薦一支晚餐配的紅酒', null, mChar);
  check('M1 無關語 → 不遞招', noOffer.block === '', noOffer.block ? '誤遞' : '');

  // M2: START 信號
  await db.collection(COL.conversations).doc(`${TEST_USER}_${TEST_CHAR}`).set({
    userId: TEST_USER, characterId: TEST_CHAR, messages: [], messageCount: 0, updatedAt: new Date(),
  });
  await applyMethodologySignals(db, TEST_USER, TEST_CHAR,
    { methodStart: mRef.id, methodNext: false, methodExit: false }, null, null);
  let conv = (await db.collection(COL.conversations).doc(`${TEST_USER}_${TEST_CHAR}`).get()).data() as { activeMethodology?: ActiveMethodologyState | null };
  check('M2 START → step=1 寫入', conv.activeMethodology?.step === 1 && conv.activeMethodology?.id === mRef.id);

  // M3: 進行中注入 + NEXT
  const inProgress = await loadMethodologyBlock(db, TEST_CHAR, '嗯我想想', conv.activeMethodology, mChar);
  check('M3 進行中 → 注入第 1 步', inProgress.block.includes('第 1/3 步') && inProgress.block.includes('理想中的一天'));
  await applyMethodologySignals(db, TEST_USER, TEST_CHAR,
    { methodStart: null, methodNext: true, methodExit: false }, conv.activeMethodology, inProgress.active);
  conv = (await db.collection(COL.conversations).doc(`${TEST_USER}_${TEST_CHAR}`).get()).data() as { activeMethodology?: ActiveMethodologyState | null };
  check('M3 NEXT → step=2', conv.activeMethodology?.step === 2);

  // M4: EXIT
  await applyMethodologySignals(db, TEST_USER, TEST_CHAR,
    { methodStart: null, methodNext: false, methodExit: true }, conv.activeMethodology, inProgress.active);
  conv = (await db.collection(COL.conversations).doc(`${TEST_USER}_${TEST_CHAR}`).get()).data() as { activeMethodology?: ActiveMethodologyState | null };
  check('M4 EXIT → 狀態清空', conv.activeMethodology == null);

  // ── T1: 標記剝離 ──────────────────────────────────────────────────────────
  const parsed = parseToolTags('好，我們慢慢來。[[METHOD_START id="abc123"]]先跟我說說你理想中的一天長什麼樣？[[METHOD_NEXT]][[METHOD_EXIT]]');
  check('T1 METHOD 標記全剝離', !parsed.visible.includes('METHOD') && parsed.methodStart === 'abc123' && parsed.methodNext && parsed.methodExit,
    parsed.visible.slice(0, 40));

  await mRef.delete();
} finally {
  // ── 自清 ──────────────────────────────────────────────────────────────────
  if (kdocId) await deleteKnowledgeDoc(db, TEST_CHAR, kdocId).catch(() => {});
  await db.collection(COL.conversations).doc(`${TEST_USER}_${TEST_CHAR}`).delete().catch(() => {});
  await db.collection(COL.characters).doc(TEST_CHAR).delete().catch(() => {});
}

console.log(`\n結果：${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
