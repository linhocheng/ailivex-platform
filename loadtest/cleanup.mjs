// 負載實測收尾：清掉測試帳號的所有痕跡。
// 清單對齊 agent 會寫的每個 collection：users / characters / conversations /
// memories / relationships / diary / impressions / tasks / jobs / documents。
// 用法：node loadtest/cleanup.mjs   （在 ailivex-platform 根目錄跑）
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);
const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const USER = 'loadtest_user';
const CHAR = 'loadtest_char';
let total = 0;

// (userId, characterId) 綁定的 collections — 用查詢掃
for (const col of ['memories', 'diary', 'impressions', 'tasks', 'jobs', 'documents']) {
  const snap = await db.collection(col).where('userId', '==', USER).get();
  for (const d of snap.docs) { await d.ref.delete(); total++; }
  console.log(`${col}: ${snap.size} deleted`);
}

// docId = `${userId}_${characterId}` 慣例的 collections
for (const col of ['conversations', 'relationships', 'access']) {
  const ref = db.collection(col).doc(`${USER}_${CHAR}`);
  if ((await ref.get()).exists) { await ref.delete(); total++; console.log(`${col}/${USER}_${CHAR} deleted`); }
}

// 最後刪主體，並回報計量總秒數（對賬用）
const userSnap = await db.collection('users').doc(USER).get();
if (userSnap.exists) {
  console.log(`voiceSecondsUsed（本次實測總計量）: ${userSnap.data().voiceSecondsUsed ?? 0}s`);
  await userSnap.ref.delete(); total++;
}
const charRef = db.collection('characters').doc(CHAR);
if ((await charRef.get()).exists) { await charRef.delete(); total++; }

console.log(`cleanup done — ${total} docs deleted`);
