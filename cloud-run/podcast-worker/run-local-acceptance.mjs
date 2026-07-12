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
// 一律直連：.env.local 的 BRIDGE_URL 過 CF，長呼叫會被 100s 斷頭鍘 524
process.env.BRIDGE_URL = 'https://bridge-direct.soul-polaroid.work';
process.env.BRIDGE_SECRET = get('BRIDGE_SECRET');
process.env.WORKER_SECRET = 'local-test';
process.env.JOB_MODE = '1'; // 不開 HTTP server

if (!process.env.BRIDGE_SECRET) { console.error('BRIDGE_SECRET 不在 .env.local'); process.exit(1); }

const { db, loadCharacters, runScriptWork } = await import('./dist/index.js');

const CHAR_IDS = ['nL8NgpkXZ7afqQSOl4cm', 'FvuTQklp77Fyn8iA3pI5']; // 簡報王(打動人心) × tracy
// G 集（第三集）：上一集教了「抖著，開口」——這集面對照做了還是搞砸的人
const GOAL = '一個照著做了「抖著開口」、上了台還是搞砸的人——是方法騙了他，還是搞砸本來就在路上？';
const AUDIENCE = {
  persona: '上週照著建議上了台、簡報還是被主管當場打斷的年輕 PM',
  misconception: '以為照做了還失敗，代表連最後一招都救不了自己',
};
// 製作人開錄前的私下交代（G 集驗收：無形製作人全協定上線）
const BRIEFS = {
  nL8NgpkXZ7afqQSOl4cm: '這集有人照你的方法做了、還是搞砸了。別急著護方法——先接住那個搞砸，再談方法能不能繼續用。',
  FvuTQklp77Fyn8iA3pI5: '少給觀點，多問問題。這集把「搞砸之後的第一個晚上」帶著他走一遍——你說過路在他身上，搞砸之後那條路還在嗎。',
};
process.env.SERIES_INCLUDE_TEST = '1'; // 驗收：讓 E 集（測試 userId）進節目記憶

const taskRef = db.collection('tasks').doc();
await taskRef.set({
  userId: 'zhu_duo_acceptance',
  characterId: CHAR_IDS[0],
  type: 'podcast_generation',
  intent: '無形製作人召喚驗收',
  status: 'running',
  podcastCharacterIds: CHAR_IDS,
  podcastTopic: '緊張',
  podcastEpisodeGoal: GOAL,
  podcastAudiencePersona: AUDIENCE.persona,
  podcastAudienceMisconception: AUDIENCE.misconception,
  podcastCharacterBriefs: BRIEFS,
  createdAt: new Date(),
});
console.log(`[acceptance] taskId=${taskRef.id}`);

const characters = await loadCharacters(CHAR_IDS);
console.log(`[acceptance] characters: ${characters.map(c => c.name).join(' × ')}`);

const t0 = Date.now();
await runScriptWork(taskRef.id, characters, '緊張', 1500, undefined, GOAL, AUDIENCE, BRIEFS);
console.log(`[acceptance] 耗時 ${Math.round((Date.now() - t0) / 1000)}s`);

const snap = await taskRef.get();
const d = snap.data();
console.log(`[acceptance] status=${d.status} mode=${d.podcastMode} lines=${d.podcastScript?.length ?? 0} turns=${d.podcastTurns?.length ?? 0}`);
process.exit(0);
