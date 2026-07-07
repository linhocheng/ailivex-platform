// 鞏固管線端到端驗證：真模組＋真 Firestore＋測試配對（zhu-test-consol，收尾全清）
// 鑑別信號：
//   ①bootstrap：合成情節 → 形成印象（support 歸併同件事、skip 瑣事）
//   ②矛盾：既有印象「住台北」＋新情節「搬高雄」→ contradict → supersededBy 鏈 + 舊印象 superseded
//   ③讀取：loadMemoryBlock 印象模式組出含 ◆◇～ 標記的塊，且被吸收情節不再出現
// 用法：npx tsx scripts/_zhu_verify_consolidation.ts
import { readFileSync } from 'fs';
import admin from 'firebase-admin';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.IMPRESSION_CANARY_USERS = 'zhu-test-consol';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();

const U = 'zhu-test-consol';
const C = 'test-char-consol';

async function cleanup() {
  for (const col of ['memories', 'impressions']) {
    const snap = await db.collection(col).where('userId', '==', U).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  await db.collection('relationships').doc(`${U}_${C}`).delete().catch(() => {});
}

async function seedEpisode(content: string, type: string, daysAgo: number) {
  await db.collection('memories').add({
    userId: U, characterId: C, content, type, tier: 'fresh', status: 'active',
    importance: 6, hitCount: 0, lastHitAt: null, source: 'extraction',
    createdAt: new Date(Date.now() - daysAgo * 86400_000),
  });
}

(async () => {
  const { consolidatePair } = await import('../src/lib/consolidation');
  const { loadMemoryBlock } = await import('../src/lib/memory');
  const { getAnthropicClient } = await import('../src/lib/anthropic-via-bridge');
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY!);

  await cleanup();
  await db.collection('relationships').doc(`${U}_${C}`).set({
    userId: U, characterId: C, conversationCount: 3,
    firstConversationAt: new Date(Date.now() - 30 * 86400_000),
    lastConversationAt: new Date(),
  });

  console.log('=== 信號① bootstrap：合成情節 → 印象 ===');
  await seedEpisode('用戶住在台北大安區', 'fact', 20);
  await seedEpisode('用戶提到通勤到內湖上班很累', 'fact', 18);
  await seedEpisode('用戶在一家科技公司當產品經理', 'fact', 15);
  await seedEpisode('用戶說他是 PM，最近在帶一個新產品線', 'fact', 10);
  await seedEpisode('用戶偏好早上開會，下午思考', 'preference', 8);
  await seedEpisode('用戶今天午餐吃了牛肉麵', 'fact', 5);

  const r1 = await consolidatePair(db as never, U, C, '測試角色', client as never);
  console.log(`status=${r1.status} episodes=${r1.episodes} new=${r1.created} support=${r1.supported} skip=${r1.skipped}`);
  for (const d of r1.detail ?? []) console.log('  ', JSON.stringify(d));

  const imps1 = await db.collection('impressions').where('userId', '==', U).get();
  console.log('\n形成的印象：');
  imps1.forEach(d => {
    const i = d.data();
    console.log(`  [${i.status}] (${i.kind}) ${i.content} ←支持 ${i.supportingEpisodes.length} 條`);
  });

  console.log('\n=== 信號② 矛盾：新情節推翻既有印象 ===');
  await seedEpisode('用戶說他上個月已經搬到高雄左營，現在遠端工作', 'fact', 1);
  const r2 = await consolidatePair(db as never, U, C, '測試角色', client as never);
  console.log(`status=${r2.status} superseded=${r2.superseded}`);
  for (const d of r2.detail ?? []) console.log('  ', JSON.stringify(d));

  const imps2 = await db.collection('impressions').where('userId', '==', U).get();
  console.log('\n裁決後的印象全景：');
  let supersedeChainOk = false;
  imps2.forEach(d => {
    const i = d.data();
    console.log(`  [${i.status}] ${i.content}${i.supersededBy ? ` →被 ${i.supersededBy.slice(0, 6)} 取代` : ''}`);
    if (i.status === 'superseded' && i.supersededBy) supersedeChainOk = true;
  });
  console.log('supersede 鏈存在:', supersedeChainOk, '（期待 true）');

  console.log('\n=== 信號③ 讀取端：印象模式 prompt 塊 ===');
  const block = await loadMemoryBlock(db as never, U, C, '你最近工作怎麼樣');
  console.log(block);
  const hasMarkers = /[◆◇～]/.test(block);
  const absorbed = !block.includes('用戶住在台北大安區'); // 被吸收的原始情節不再出現
  console.log('\n信心標記出現:', hasMarkers, '（期待 true）｜被吸收情節已隱藏:', absorbed, '（期待 true）');

  await cleanup();
  console.log('\n測試資料已清理');
  process.exit(0);
})();
