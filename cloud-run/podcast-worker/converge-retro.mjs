/**
 * 收斂台回放：對已 scripted 的 duo task 單獨補跑無形製作人收斂
 * 用法：node converge-retro.mjs <taskId>
 */
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
process.env.JOB_MODE = '1';

const BRIDGE_ENDPOINT = `${process.env.BRIDGE_URL}/v1/messages`;
async function bridgeCall(model, system, user, maxTokens, timeoutMs = 90_000) {
  const res = await fetch(BRIDGE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.BRIDGE_SECRET },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  const d = await res.json();
  return (d.content?.[0]?.text ?? '').trim();
}

const { db } = await import('./dist/index.js');
const { loadProducerSoul, convergeScript } = await import('./dist/invisible-producer.js');
const { loadCorpus } = await import('./dist/belief.js');
const { loadPatterns } = await import('./dist/text-filter.js');

const taskId = process.argv[2];
if (!taskId) { console.error('用法：node converge-retro.mjs <taskId>'); process.exit(1); }

const ref = db.collection('tasks').doc(taskId);
const d = (await ref.get()).data();
if (!d?.podcastTurns?.length) { console.error('task 沒有 podcastTurns'); process.exit(1); }

const turns = d.podcastTurns;
const charIds = d.podcastCharacterIds;
const charSnaps = await Promise.all(charIds.map(id => db.collection('characters').doc(id).get()));
const chars = charSnaps.map((s, i) => ({ id: charIds[i], ...s.data() }));
const beliefs = new Map(Object.entries(d.podcastBeliefStates));
const corpusOf = new Map(await Promise.all(charIds.map(async id => [id, await loadCorpus(db, id)])));
const audience = { persona: d.podcastAudiencePersona, misconception: d.podcastAudienceMisconception };
const [soul, patterns] = await Promise.all([loadProducerSoul(db), loadPatterns(db)]);
console.log(`[retro] ${chars.map(c => c.name).join('×')}｜${turns.length} 輪｜soul=${soul ? 'Y' : 'N'}`);

const t0 = Date.now();
const result = await convergeScript(
  bridgeCall, soul ?? '你是這集對話的製作人，負責後製收斂。',
  d.podcastEpisodeGoal, audience, turns, chars, beliefs, corpusOf, patterns, d.podcastTopic, d.podcastFocus,
);
console.log(`[retro] 耗時 ${Math.round((Date.now() - t0) / 1000)}s｜TRIM ${result.trims}｜RETAKE ${result.retakes}｜儀器命中 ${result.filterHits}`);
console.log(`[retro] 後記：${result.epilogue}`);

const script = turns.map(t => ({ speaker: t.speaker, characterId: t.characterId, text: t.utterance.replace(/\\n/g, '\n') }));
turns.forEach((t, i) => { t.utterance = script[i].text; });
await ref.update({
  podcastScript: script,
  podcastTurns: turns.map(t => JSON.parse(JSON.stringify(t))),
  podcastConvergence: { trims: result.trims, retakes: result.retakes, filterHits: result.filterHits },
  ...(result.epilogue ? { podcastProducerEpilogue: result.epilogue } : {}),
});
console.log('[retro] 已寫回 task doc');
process.exit(0);
