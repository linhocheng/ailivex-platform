import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const env = readFileSync('/Users/adamlin/.ailive/ailivex-platform/.env.local', 'utf8');
const m = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON=['"]?(\{.*\})['"]?/);
const sa = JSON.parse(m[1]);
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// 找角色
const chars = await db.collection('characters').get();
const targets = [];
for (const d of chars.docs) {
  const c = d.data();
  if (/簡報|Tracy|tracy/i.test(c.name ?? '')) targets.push({ id: d.id, name: c.name, chunkCount: c.knowledgeChunkCount ?? 0 });
}
console.log('候選角色:', JSON.stringify(targets, null, 1));

for (const t of targets) {
  const docs = await db.collection('knowledge_docs').where('characterId', '==', t.id).get();
  console.log(`\n${t.name} (${t.id}) — knowledge_docs ${docs.size} 份:`);
  docs.docs.forEach(d => {
    const k = d.data();
    console.log(`  - [${k.docType}/${k.authority}/${k.status}] ${k.title} (${k.chunkCount} chunks)`);
  });
  const meth = await db.collection('methodologies').where('characterId', '==', t.id).get().catch(() => ({ size: 'n/a', docs: [] }));
  console.log(`  methodologies: ${meth.size}`);
}
