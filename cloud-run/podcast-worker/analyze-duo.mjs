/**
 * duo 驗收指標 — 規格書 v1 第九章對照表，全程式計算（node analyze-duo.mjs <taskId>）
 */
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
process.env.BRIDGE_URL = 'https://x.invalid'; process.env.BRIDGE_SECRET = 'x'; // 只讀 DB，不打 bridge

const { db } = await import('./dist/index.js');

const taskId = process.argv[2];
const snap = await db.collection('tasks').doc(taskId).get();
if (!snap.exists) { console.error('task 不存在'); process.exit(1); }
const d = snap.data();
const turns = d.podcastTurns ?? [];
const meta = d.podcastEpisodeMeta ?? null;
const events = d.podcastProducerEvents ?? [];

const TWO_THINGS = /是兩(件事|回事)|是兩個(問題|層次|東西|概念|議題)|這是兩層|分屬兩個/;
const FAKE_CONCEDE = /(這個|這點|這比喻)?我(接|同意|認同)[了]?[，,。—-]*\s*但/;
const CASE_CLAIM = /我(有|帶過|遇過|教過)一?個|我們(公司|團隊)有|去年有[位個]|有[位個](學員|客戶|主管)/;

const half = Math.floor(turns.length / 2);
const secondHalf = turns.slice(half);
const endsQ = t => /[？?]\s*$/.test((t.utterance ?? '').trim());

let consecQ = 0;
for (let i = 1; i < turns.length; i++) if (endsQ(turns[i]) && endsQ(turns[i - 1])) consecQ++;

const unverifiedCases = turns.filter(t =>
  CASE_CLAIM.test(t.utterance) && !/假設一個情境|打個比方|假設有/.test(t.utterance) && (!t.evidenceRefs || t.evidenceRefs.length === 0));

const rows = [
  ['立場位移次數', `${(meta?.beliefDeltas ?? []).length} 次 ${(meta?.beliefDeltas ?? []).map(x => `(${x.speaker} 第${x.turnId}輪)`).join(' ')}`, '≥1 且可指出哪一輪'],
  ['「兩件事」句型', `${turns.filter(t => TWO_THINGS.test(t.utterance)).length} 次`, '≤3'],
  ['假讓步（接—但）', `${turns.filter(t => FAKE_CONCEDE.test(t.utterance)).length} 次`, '0'],
  ['後半段問號結尾比例', `${secondHalf.length ? Math.round(100 * secondHalf.filter(endsQ).length / secondHalf.length) : 0}%`, '≤40%'],
  ['連續兩輪問號結尾', `${consecQ} 處`, '0'],
  ['未查證案例', `${unverifiedCases.length} 個`, '0'],
  ['終止方式', meta?.takeaways?.length === 3 ? `交付（takeaways×${meta.takeaways.length}）` : '未交付', '交付'],
  ['Producer 介入', `${events.length} 次（${events.map(e => e.action).join('/') || '無'}）`, '—'],
  ['帶 warnings 的輪次', `${turns.filter(t => t.warnings?.length).length}/${turns.length}`, '愈少愈好'],
];
console.log(`\n═══ duo 驗收 task=${taskId}｜${turns.length} 輪 ═══`);
console.log(`EPISODE_GOAL: ${meta?.episodeGoal ?? d.podcastEpisodeGoal ?? '—'}`);
console.log(`分歧宣言: ${meta?.disagreementStatement ?? '—'}\n`);
rows.forEach(([k, v, std]) => console.log(`${k.padEnd(14, '　')}｜${String(v).padEnd(40)}｜標準：${std}`));
if (meta) {
  console.log(`\n共識: ${JSON.stringify(meta.consensus, null, 0)}`);
  console.log(`誠實保留的分歧: ${meta.preservedDisagreement}`);
  console.log(`takeaways: ${JSON.stringify(meta.takeaways, null, 0)}`);
}
console.log('\n─── 腳本 ───');
(d.podcastScript ?? []).forEach((l, i) => console.log(`${i + 1}. [${l.speaker}] ${l.text}`));
process.exit(0);
