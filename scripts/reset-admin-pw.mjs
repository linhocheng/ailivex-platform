import { readFileSync } from 'fs';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';
import { createRequire } from 'module';

// 用法：node scripts/reset-admin-pw.mjs <username> <password>
// 帳號、密碼皆必填 —— 不再硬編任何 doc id 或預設密碼（避免真憑證進 git 歷史）。
const require = createRequire(import.meta.url);
const scryptAsync = promisify(scrypt);

const username = process.argv[2]?.trim();
const password = process.argv[3];
if (!username || !password) {
  console.error('用法：node scripts/reset-admin-pw.mjs <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('密碼至少 8 碼');
  process.exit(1);
}

// 從 .env.local 取 SA JSON：值是單行、外層雙（或單）引號包覆。
// 不用 node --env-file（它的 dotenv 解析會把含引號的單行 JSON 弄壞）。
const envRaw = readFileSync('.env.local', 'utf8');
const line = envRaw.split('\n').find(l => l.startsWith('FIREBASE_SERVICE_ACCOUNT_JSON='));
let SA_JSON = line?.slice('FIREBASE_SERVICE_ACCOUNT_JSON='.length) ?? '';
if ((SA_JSON.startsWith('"') && SA_JSON.endsWith('"')) || (SA_JSON.startsWith("'") && SA_JSON.endsWith("'"))) {
  SA_JSON = SA_JSON.slice(1, -1);   // 剝外層引號，內層即合法 JSON
}
if (!SA_JSON) {
  console.error('.env.local 缺 FIREBASE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA_JSON)) });
}
const db = admin.firestore();

// 用 username 查 doc，不硬編 doc id
const snap = await db.collection('users').where('username', '==', username).limit(1).get();
if (snap.empty) {
  console.error(`找不到帳號：${username}`);
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
const derived = await scryptAsync(password, salt, 64);
const passwordHash = salt + ':' + derived.toString('hex');

await snap.docs[0].ref.update({ passwordHash });
console.log(`已重設帳號 ${username}（doc ${snap.docs[0].id}）的密碼。`);
process.exit(0);
