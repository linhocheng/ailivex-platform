import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const env = readFileSync('/Users/adamlin/.ailive/ailivex-platform/.env.local', 'utf8');
const saMatch = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON=['"]?(\{.*\})['"]?/);
const saPath = join(tmpdir(), 'zhu-duo-sa.json');
writeFileSync(saPath, saMatch[1]);
process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
process.env.FIREBASE_PROJECT_ID = 'ailivex-2026';
process.env.JOB_MODE = '1';
process.env.BRIDGE_URL = 'https://x.invalid'; process.env.BRIDGE_SECRET = 'x';
const { db } = await import('./dist/index.js');
const id = process.argv[2];
for (let i = 0; i < 240; i++) {
  const s = await db.collection('tasks').doc(id).get();
  const d = s.data();
  if (d.status === 'scripted') {
    console.log(`SCRIPTED lines=${d.podcastScript?.length} mode=${d.podcastMode} meta=${d.podcastEpisodeMeta ? 'YES' : 'NO'} deltas=${d.podcastEpisodeMeta?.beliefDeltas?.length ?? '-'}`);
    process.exit(0);
  }
  if (d.status === 'failed') { console.log(`FAILED: ${d.error}`); process.exit(1); }
  await new Promise(r => setTimeout(r, 10000));
}
console.log('TIMEOUT');
process.exit(1);
