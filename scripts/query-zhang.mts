import * as admin from 'firebase-admin';
import * as fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const match = envContent.match(/FIREBASE_SERVICE_ACCOUNT_JSON="(\{[\s\S]*?\})"\s*\n/);
if (!match) { console.error('Cannot parse SA JSON'); process.exit(1); }
// Fix literal \n in private_key
const jsonStr = match[1].replace(/\\n/g, '\n');
const sa = JSON.parse(jsonStr);

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const charSnap = await db.collection('characters').where('name', '==', '張立').get();
if (charSnap.empty) { console.log('No character named 張立'); process.exit(0); }
const charId = charSnap.docs[0].id;
console.log('charId:', charId);
console.log('capabilities:', charSnap.docs[0].data().capabilities);

const taskSnap = await db.collection('tasks')
  .where('characterId', '==', charId)
  .where('type', '==', 'script_draft')
  .get();

console.log('\n=== script_draft tasks ===', taskSnap.size, 'total');
const tasks = taskSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
tasks.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
tasks.slice(0, 5).forEach((t) => {
  console.log('\nid:', t.id);
  console.log('status:', t.status, '| userId:', t.userId);
  console.log('intent:', t.intent);
  console.log('params:', JSON.stringify(t.params || {}).slice(0, 200));
  console.log('scriptText:', t.scriptText?.slice(0, 500) || '(empty)');
});
