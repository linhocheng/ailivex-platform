/**
 * duo 管線本機驗收 — 簡報王 × Tracy 真跑一集
 * bridge 走 Max（零付費 key）；寫入僅一筆測試 task doc（userId=zhu_duo_acceptance）
 */
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 從平台 .env.local 取 bridge 與 SA（不外印）
const env = readFileSync('/Users/adamlin/.ailive/ailivex-platform/.env.local', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=['"]?([^\\n'"]+)`, 'm'))?.[1] ?? '';
const saMatch = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON=['"]?(\{.*\})['"]?/);
const saPath = join(tmpdir(), 'zhu-duo-sa.json');
writeFileSync(saPath, saMatch[1]);
process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
process.env.FIREBASE_PROJECT_ID = 'ailivex-2026';
process.env.BRIDGE_URL = get('BRIDGE_URL') || 'https://bridge-direct.soul-polaroid.work';
process.env.BRIDGE_SECRET = get('BRIDGE_SECRET');
process.env.WORKER_SECRET = 'local-test';
process.env.JOB_MODE = '1'; // 不開 HTTP server

if (!process.env.BRIDGE_SECRET) { console.error('BRIDGE_SECRET 不在 .env.local'); process.exit(1); }

const { db, loadCharacters, runScriptWork } = await import('./dist/index.js');

const CHAR_IDS = ['nL8NgpkXZ7afqQSOl4cm', 'FvuTQklp77Fyn8iA3pI5']; // 簡報王(打動人心) × tracy
const GOAL = '一個很會教別人上台的人，自己上台前還會緊張——這說明方法失效了，還是方法本來就不是用來消除緊張的？';

const taskRef = db.collection('tasks').doc();
await taskRef.set({
  userId: 'zhu_duo_acceptance',
  characterId: CHAR_IDS[0],
  type: 'podcast_generation',
  intent: 'Voice Layer Phase A 驗收',
  status: 'running',
  podcastCharacterIds: CHAR_IDS,
  podcastTopic: '緊張',
  podcastEpisodeGoal: GOAL,
  createdAt: new Date(),
});
console.log(`[acceptance] taskId=${taskRef.id}`);

const characters = await loadCharacters(CHAR_IDS);
console.log(`[acceptance] characters: ${characters.map(c => c.name).join(' × ')}`);

const t0 = Date.now();
await runScriptWork(taskRef.id, characters, '緊張', 1500, undefined, GOAL);
console.log(`[acceptance] 耗時 ${Math.round((Date.now() - t0) / 1000)}s`);

const snap = await taskRef.get();
const d = snap.data();
console.log(`[acceptance] status=${d.status} mode=${d.podcastMode} lines=${d.podcastScript?.length ?? 0} turns=${d.podcastTurns?.length ?? 0}`);
process.exit(0);
