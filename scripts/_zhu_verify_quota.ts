// 驗證 quota lib：只有修好才會出現的信號 =
//   docsLimit=1 時第 1 次 consume 過、第 2 次丟 QuotaExceededError；refund 後又能 consume
//   voiceSecondsLimit=60、used=60 時 checkVoiceQuota 丟錯
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
const env = readFileSync('.env.local', 'utf-8');
const m = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON=(.+)\n/);
const raw = m![1].trim().replace(/^['"]|['"]$/g, '');
const sa = JSON.parse(raw);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = raw;

(async () => {
  const { consumeDocQuota, refundDocQuota, checkVoiceQuota, addVoiceSeconds, QuotaExceededError } = await import('../src/lib/quota');
  const db = admin.firestore() as unknown as Parameters<typeof consumeDocQuota>[0];
  const TEST_ID = '_zhu_quota_test';
  const ref = admin.firestore().collection('users').doc(TEST_ID);
  await ref.set({ username: '_zhu_test', displayName: 'quota test', role: 'user', passwordHash: 'x', createdAt: new Date(), docsLimit: 1, voiceSecondsLimit: 60 });

  const results: string[] = [];
  // docs: 1st consume ok
  try { await consumeDocQuota(db, TEST_ID); results.push('consume#1: ok ✅'); }
  catch { results.push('consume#1: 意外被擋 ❌'); }
  // 2nd consume should throw
  try { await consumeDocQuota(db, TEST_ID); results.push('consume#2: 沒擋 ❌'); }
  catch (e) { results.push(e instanceof QuotaExceededError ? 'consume#2: 正確擋下 ✅' : `consume#2: 錯誤型別 ❌ ${e}`); }
  // refund then consume ok
  await refundDocQuota(db, TEST_ID);
  try { await consumeDocQuota(db, TEST_ID); results.push('refund後consume: ok ✅'); }
  catch { results.push('refund後consume: 被擋 ❌'); }
  // voice: remaining 60 → pass
  try { const q = await checkVoiceQuota(db, TEST_ID); results.push(`voice check (remaining=${q.voiceSecondsRemaining}): ok ✅`); }
  catch { results.push('voice check: 意外被擋 ❌'); }
  // burn 60s → should throw
  await addVoiceSeconds(db, TEST_ID, 60);
  try { await checkVoiceQuota(db, TEST_ID); results.push('voice 用完後: 沒擋 ❌'); }
  catch (e) { results.push(e instanceof QuotaExceededError ? 'voice 用完後: 正確擋下 ✅' : `voice: 錯誤型別 ❌`); }

  await ref.delete();
  results.forEach(r => console.log(r));
  console.log(results.every(r => r.includes('✅')) ? '\n全部通過' : '\n有失敗');
  process.exit(0);
})();
