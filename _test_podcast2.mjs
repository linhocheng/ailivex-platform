import { readFileSync } from 'fs';
import { createRequire } from 'module';

const envRaw = readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  env[m[1]] = v;
}
const SA = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
const WORKER_SECRET = (env.WORKER_SECRET ?? '').trim().replace(/\\n$/, '');

const req = createRequire(import.meta.url);
const admin = req('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(SA), projectId: SA.project_id });
const db = admin.firestore();
const { FieldValue } = req('firebase-admin/firestore');

const WORKER_URL = 'https://ailivex-podcast-worker-6ybo3vltfq-de.a.run.app';
const WORD_COUNT = parseInt(process.argv[2] ?? '600', 10);
const TOPIC = '現代人追求身心靈、自我成長與顯化，這跟佛法倡導的那種苦修與內斂有很大的不同。那兩位怎麼看？';
const FOCUS = '顯化究竟是一種慾望，還是一種正確的自我道路？';

// 聖嚴 × 達賴喇嘛
const CHAR_IDS = ['8mCpOmbJalsvdUxGRFzn', 'e4LWiHK0bMB45h0vhTN9'];
const charSnaps = await Promise.all(CHAR_IDS.map(id => db.collection('characters').doc(id).get()));
const chars = charSnaps.map((s, i) => ({ id: CHAR_IDS[i], name: s.data().name }));
console.log('characters:', chars.map(c=>`${c.name}`).join(' × '), `| target: ${WORD_COUNT}字`);

const taskRef = db.collection('tasks').doc();
await taskRef.set({
  userId: 'zhu-internal-test-2',
  characterId: chars[0].id,
  type: 'podcast_generation',
  intent: `語感測試：${WORD_COUNT}字`,
  status: 'running',
  notified: false,
  podcastCharacterIds: chars.map(c=>c.id),
  podcastTopic: TOPIC,
  podcastFocus: FOCUS,
  podcastWordCount: WORD_COUNT,
  createdAt: FieldValue.serverTimestamp(),
});
console.log('taskId:', taskRef.id);

// fire: expect 202 immediately now (background processing with --no-cpu-throttling)
const startMs = Date.now();
const r = await fetch(`${WORKER_URL}/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
  body: JSON.stringify({ taskId: taskRef.id, characterIds: chars.map(c=>c.id),
    topic: TOPIC, focus: FOCUS, wordCount: WORD_COUNT }),
  signal: AbortSignal.timeout(30_000),
});
const body = await r.json();
const fireMs = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`worker responded (${fireMs}s): HTTP ${r.status}`, JSON.stringify(body));

// poll Firestore until scripted or failed (max 25 min)
const MAX_MS = 25 * 60 * 1000;
const POLL_MS = 5000;
const deadline = Date.now() + MAX_MS;

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, POLL_MS));
  const t = await taskRef.get();
  const d = t.data();
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  const scriptLen = d?.podcastScript?.length ?? 0;
  const wordCount = d?.podcastScript?.reduce((s,l) => s+l.text.length, 0) ?? 0;
  console.log(`[${elapsed}s] status=${d?.status} | lines=${scriptLen} | chars=${wordCount}`);
  if (d?.status === 'scripted' || d?.status === 'done') {
    const script = d.podcastScript ?? [];
    console.log(`\n=== 結果：${script.length} 輪，${script.reduce((s,l)=>s+l.text.length,0)} 字 ===\n`);
    script.forEach(l => console.log(`[${l.speaker}]: ${l.text}\n`));
    process.exit(0);
  }
  if (d?.status === 'failed') {
    console.error('FAILED:', d?.error);
    process.exit(1);
  }
}

console.error('TIMEOUT: task still running after 25 min');
process.exit(1);
