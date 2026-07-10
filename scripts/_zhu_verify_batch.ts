// 連線批次驗證：①promise 兌現裁決（真 LLM）②日記沉澱（真 LLM）③結構斷言。測試配對，收尾全清。
import { readFileSync } from 'fs';
import admin from 'firebase-admin';
const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.DIARY_CANARY_USERS = 'zhu-test-batch';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();
const U = 'zhu-test-batch', C = 'test-char-batch';

async function cleanup() {
  for (const col of ['memories', 'diary']) {
    const s = await db.collection(col).where('userId', '==', U).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
  await db.collection('relationships').doc(`${U}_${C}`).delete().catch(() => {});
}

(async () => {
  const { extractAndSaveMemories } = await import('../src/lib/memory');
  const { consolidateDiaries } = await import('../src/lib/diary');
  const { getAnthropicClient } = await import('../src/lib/anthropic-via-bridge');
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY!);
  await cleanup();

  console.log('=== ① promise 兌現裁決 ===');
  await db.collection('memories').add({
    userId: U, characterId: C, content: '我答應了幫他整理一份閱讀清單', type: 'promise',
    tier: 'fresh', status: 'active', importance: 7, hitCount: 0, lastHitAt: null,
    source: 'extraction', createdAt: new Date(Date.now() - 5 * 86400_000),
  });
  await extractAndSaveMemories(db as never, U, C, '測試角色', [
    { role: 'assistant', content: '上次答應你的閱讀清單我整理好了：《莊子》《人的境況》《禪與摩托車維修的藝術》，都放在這裡了。' },
    { role: 'user', content: '收到！太好了，我這週末就開始讀。' },
  ], client as never);
  const p = await db.collection('memories').where('userId', '==', U).where('type', '==', 'promise').get();
  const resolved = p.docs.filter(d => d.data().status === 'resolved').length;
  console.log(`promise resolved: ${resolved}/1（期待 1）`);

  console.log('\n=== ② 日記沉澱（13 篇 → 觸發吸收最舊 8 篇）===');
  await db.collection('relationships').doc(`${U}_${C}`).set({ userId: U, characterId: C, conversationCount: 13, firstConversationAt: new Date(), lastConversationAt: new Date() });
  for (let i = 0; i < 13; i++) {
    await db.collection('diary').add({
      userId: U, characterId: C,
      entry: `第 ${i + 1} 天：他今天聊到工作上的困境，我${i % 3 === 0 ? '有點擔心他' : '陪他想了想辦法'}。`,
      unspoken: i === 2 ? ['他好像一直沒睡好'] : [], nextTime: i === 5 ? ['問他睡眠有沒有改善'] : [],
      mood: '平靜', source: 'text', status: 'active',
      createdAt: new Date(Date.now() - (20 - i) * 86400_000),
    });
  }
  const dg = await consolidateDiaries(db as never, client as never);
  const after = await db.collection('diary').where('userId', '==', U).get();
  const act = after.docs.filter(d => (d.data().status ?? 'active') === 'active');
  const arch = after.docs.filter(d => d.data().status === 'archived');
  const digest = after.docs.filter(d => d.data().source === 'digest');
  console.log(`digested pairs=${dg.digested}｜active=${act.length}（期待 6=13-8+1）｜archived=${arch.length}（期待 8）｜digest 篇=${digest.length}（期待 1）`);
  const dd = digest[0]?.data();
  if (dd) console.log(`digest 結構：entry=${dd.entry.length}字 unspoken繼承=${dd.unspoken.length} nextTime繼承=${dd.nextTime.length} 可溯=${arch.every(a => a.data().digestedInto === digest[0].id)}`);

  await cleanup();
  console.log('\n測試資料已清理');
  process.exit(0);
})();
