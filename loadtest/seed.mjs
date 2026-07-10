// 負載實測：建立隔離測試帳號 + 測試角色。
// 合成通話的所有 Firestore 寫入（額度計量、記憶、lastSession、關係、日記）
// 全部落在這兩個 docId 底下，不碰任何真用戶/真角色。測完跑 cleanup.mjs。
//
// 用法：node loadtest/seed.mjs   （在 ailivex-platform 根目錄跑，讀 .env.local）
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);
const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(sa) });
const db = getFirestore();

export const LOADTEST_USER_ID = 'loadtest_user';
export const LOADTEST_CHAR_ID = 'loadtest_char';

const now = new Date().toISOString();

await db.collection('users').doc(LOADTEST_USER_ID).set({
  username: 'loadtest_user',
  passwordHash: 'LOCKED-no-login',   // 不可登入：只作為 agent 計量/寫入的掛靠點
  displayName: '負載測試（勿動，測完自動清除）',
  role: 'user',
  createdAt: now,
  // 語音額度不設 limit = 不限（metadata 也會帶 null）；計量照寫，方便測後核對總秒數
});

await db.collection('characters').doc(LOADTEST_CHAR_ID).set({
  name: '測試員',
  // 靈魂刻意極簡＋強制短回應：turn latency 量的是「開口速度」，回應長短無關，
  // 短回應 = 每分鐘更多回合 = 更多樣本點，也省 TTS/LLM 錢
  soul: '你是語音系統負載測試的對話對象。不管聽到什麼，用一到兩句話簡短回應即可。不要提問、不要展開話題。',
  avatarUrl: '',
  voiceIdMinimax: '',               // 空 → agent 用 MINIMAX_DEFAULT_VOICE_ID
  status: 'active',
  aliases: [],
  capabilities: [],
  createdAt: now,
});

console.log(`seeded: users/${LOADTEST_USER_ID} + characters/${LOADTEST_CHAR_ID}`);
console.log('（無 access doc——loadtest 不走平臺 token route，harness 自行 mint token）');
