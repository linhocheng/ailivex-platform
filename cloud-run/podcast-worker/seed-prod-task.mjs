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
const ref = db.collection('tasks').doc();
await ref.set({
  userId: 'zhu_duo_acceptance',
  characterId: 'nL8NgpkXZ7afqQSOl4cm',
  type: 'podcast_generation',
  intent: 'duo 生產驗證：Cloud Run Job',
  status: 'running',
  podcastCharacterIds: ['nL8NgpkXZ7afqQSOl4cm', 'FvuTQklp77Fyn8iA3pI5'],
  podcastTopic: '簡報與教練',
  podcastEpisodeGoal: '一個很會教別人上台的人，自己上台前還會緊張——這說明方法失效了，還是方法本來就不是用來消除緊張的？',
  createdAt: new Date(),
});
console.log(ref.id);
process.exit(0);
