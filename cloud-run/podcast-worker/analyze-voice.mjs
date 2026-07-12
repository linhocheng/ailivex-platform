/**
 * Voice Layer 驗收指標 — 規格書第 8 節（node analyze-voice.mjs <taskId>）
 * MOVE-1/2 命中、複述+表態開頭、字數變異數、棄權、具體細節密度
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
process.env.BRIDGE_URL = 'https://x.invalid'; process.env.BRIDGE_SECRET = 'x';
const { db } = await import('./dist/index.js');

const MOVE1 = [
  /(這個|這點|這比喻)?我(接|收下)[了]?[，,。—-]/, /我保留的是/, /這(一點|個)我(同意|認同)/,
  /你說[^，。？]{2,20}[，,]\s*我/, /我們的分歧(在|是)/, /我想(挑|逼|追問|問得更細)/,
  /今天(能)?帶走/, /這才是(重點|終點|關鍵)/, /假設一個情境/, /我要反駁(一個)?前提/,
  /我(同意|認同)這(一半|部分|個)/,
];
const MOVE2 = [
  /[燒炸]|引爆|點燃/, /能量|頻率|共振|張力/, /(沒有|找不到|一條)出口|流向|灌進|堵住|疏通/,
  /接住|承接(?!辦)/, /黑箱|迴路/, /(不在)?同一(層|個樓層)|樓層|底層/,
];
const CONCRETE = /\d|第[一二三四五六七八九十]+(頁|分鐘|次|輪|排)|[一二三四五]萬次|(那|這)(天|次|場)|眼睛|手(在|裡)|停了|聲音/g;

const taskId = process.argv[2];
const d = (await db.collection('tasks').doc(taskId).get()).data();
const turns = d.podcastTurns ?? [];
const lens = turns.map(t => t.utterance.length);
const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
const std = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);

const hit = (res, text) => res.filter(r => r.test(text)).length;
const move1Hits = turns.flatMap(t => MOVE1.filter(r => r.test(t.utterance)).map(r => `${t.turnId}:${t.utterance.match(r)[0]}`));
const move2Hits = turns.flatMap(t => MOVE2.filter(r => r.test(t.utterance)).map(r => `${t.turnId}:${t.utterance.match(r)[0]}`));

const echoOpen = turns.filter((t, i) => {
  if (i === 0) return false;
  const head = t.utterance.slice(0, 20);
  const oppName = turns.find(x => x.characterId !== t.characterId)?.speaker ?? '';
  return head.includes(oppName.slice(0, 4)) || /^你(說|講|剛)/.test(head) || /^(我同意[，,。]|我接[，,。]|這個我(同意|接)|說得(好|對))/.test(head);
});
const abstain = turns.filter(t => t.utterance.length < 20 || /我不知道|這個我沒想過|我不確定/.test(t.utterance));
const concrete = turns.reduce((s, t) => s + (t.utterance.match(CONCRETE) ?? []).length, 0);

// 聽眾指標（2026-07-12 關係矩陣版）：對話是否為台下那個人存在
const resonanceTurns = turns.filter(t => t.audienceResonance);
const audienceAddress = turns.filter(t => /台下|聽眾|(在|正在)聽的(人|你)|螢幕(前|外)的|如果你(也|現在|常)|聽到這裡的你/.test(t.utterance));
const b4w = (d.podcastProducerEvents ?? []).filter(e => e.action === 'BREAK_4TH_WALL');

console.log(`\n═══ Voice Layer 驗收 task=${taskId}｜${turns.length} 輪 ═══`);
if (d.podcastAudiencePersona) console.log(`聽眾：${d.podcastAudiencePersona}｜誤解：${d.podcastAudienceMisconception ?? '—'}`);
const rows = [
  ['複述+表態開頭輪次', `${echoOpen.length}/${turns.length}（第 ${echoOpen.map(t => t.turnId).join(',') || '—'} 輪）`, '≤1'],
  ['MOVE-1 命中', `${move1Hits.length}｜${move1Hits.join('、') || '—'}`, '0'],
  ['隱喻用量（已解禁，看失控與否）', `${move2Hits.length}｜${move2Hits.join('、') || '—'}`, '有人味但非每輪'],
  ['每輪字數', `${lens.join(', ')}`, ''],
  ['字數變異數（std）', `${Math.round(std)}（mean ${Math.round(mean)}）`, '高＝真人'],
  ['棄權/我不知道', `${abstain.length} 次`, '≥1'],
  ['具體細節密度', `${concrete} 處`, '≥6'],
  ['共鳴輪次（THINK 第7步非null）', `${resonanceTurns.length}/${turns.length}`, '有，但不該全滿——不硬掰'],
  ['對台下直說', `${audienceAddress.length} 次（第 ${audienceAddress.map(t => t.turnId).join(',') || '—'} 輪）`, '≥1'],
  ['BREAK_4TH_WALL 觸發', `${b4w.length} 次`, '抽象對撞時才該有'],
];
rows.forEach(([k, v, std_]) => console.log(`${k}\n  ${v}${std_ ? `　（目標：${std_}）` : ''}`));
process.exit(0);
