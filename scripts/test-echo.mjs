import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// 手動讀 .env.local
const envRaw = readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/s);
  if (!m) continue;
  env[m[1]] = m[2].replace(/^"([\s\S]*)"$/, '$1');
}

const admin = require('firebase-admin');
const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// 1. 找所有 characters
const snap = await db.collection('characters').get();
let echoId = null, echoName = null, echoCaps = [];
for (const d of snap.docs) {
  const data = d.data();
  console.log(d.id.slice(0,8), '|', data.name, '| caps:', JSON.stringify(data.capabilities ?? []));
  if (data.name?.toLowerCase().includes('echo')) {
    echoId = d.id;
    echoName = data.name;
    echoCaps = data.capabilities ?? [];
  }
}

if (!echoId) {
  console.log('\n找不到 echo，改用第一個 character');
  const first = snap.docs[0];
  echoId = first.id;
  echoName = first.data().name;
  echoCaps = first.data().capabilities ?? [];
}

console.log(`\n選定角色: ${echoName} (${echoId})`);
console.log('現有 capabilities:', echoCaps);

// 2. 確保 script_draft 在 capabilities
if (!echoCaps.includes('script_draft')) {
  const newCaps = [...echoCaps, 'script_draft'];
  await db.collection('characters').doc(echoId).update({ capabilities: newCaps });
  console.log('已加入 script_draft capability');
}

process.exit(0);
