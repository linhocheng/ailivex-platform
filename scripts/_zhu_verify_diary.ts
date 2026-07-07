// 角色日記端到端驗證：真模組 + 真 Firestore + 測試 userId（zhu-test-diary，不污染真實配對）
// 鑑別信號：①寫入後 diary collection 出現該配對文件 ②loadDiaryBlock 組出含日記內容的 prompt 塊
// ③canary 閘外的 userId 讀寫都是 no-op
// 用法：npx tsx scripts/_zhu_verify_diary.ts
import { readFileSync } from 'fs';
import admin from 'firebase-admin';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.DIARY_CANARY_USERS = 'zhu-test-diary'; // canary 只放測試帳號

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();

const TEST_USER = 'zhu-test-diary';
const CHAR_ID = 'test-char-diary';

(async () => {
  const { writeDiaryEntry, loadDiaryBlock, diaryEnabled } = await import('../src/lib/diary');
  const { getAnthropicClient } = await import('../src/lib/anthropic-via-bridge');
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY!);

  // 信號 ③：canary 閘
  console.log('canary 內（zhu-test-diary）:', diaryEnabled(TEST_USER), '（期待 true）');
  console.log('canary 外（other-user）:', diaryEnabled('other-user'), '（期待 false）');

  const soul = '你是蔣勳。溫潤、緩慢、把美學揉進日常。你相信真正的陪伴是聽懂對方沒說出來的部分。';
  const conversation = [
    { role: 'user', content: '最近工作好累，每天都加班到十一點，有點不知道為什麼要這樣。' },
    { role: 'assistant', content: '累的時候，先不要急著找意義。你有多久沒有好好吃一頓不看手機的晚餐了？' },
    { role: 'user', content: '……想不起來。可能上個月吧。其實我在考慮要不要離職，但不敢跟家裡說。' },
    { role: 'assistant', content: '這個「不敢」，比離職本身更值得看。你怕的是他們反對，還是怕他們失望？' },
    { role: 'user', content: '怕他們失望吧。我爸一直覺得這份工作很體面。下次再聊，我要去開會了。' },
  ];

  console.log('\n=== 寫日記（真 LLM via bridge）===');
  await writeDiaryEntry(db as never, TEST_USER, CHAR_ID, '蔣勳', soul, '測試用戶', conversation, client as never, 'text');

  // 信號 ①：文件存在
  const snap = await db.collection('diary').where('userId', '==', TEST_USER).get();
  console.log('diary 文件數:', snap.size, '（期待 >= 1）');
  snap.forEach(d => {
    const e = d.data();
    console.log('\n--- 日記內容 ---');
    console.log('entry:', e.entry);
    console.log('unspoken:', JSON.stringify(e.unspoken, null, 0));
    console.log('nextTime:', JSON.stringify(e.nextTime, null, 0));
    console.log('mood:', e.mood);
  });

  // 信號 ②：prompt 塊
  console.log('\n=== loadDiaryBlock 組塊 ===');
  const block = await loadDiaryBlock(db as never, TEST_USER, CHAR_ID);
  console.log(block || '（空——若索引還在建，這裡會空且上面 catch 有 log）');

  // 收尾清掉測試文件
  const cleanup = await db.collection('diary').where('userId', '==', TEST_USER).get();
  await Promise.all(cleanup.docs.map(d => d.ref.delete()));
  console.log(`\n已清理測試文件 ${cleanup.size} 份`);
  process.exit(0);
})();
