/**
 * 一次性種子：建第一個 admin 帳號。
 * 跑法：npx tsx --env-file=.env.local scripts/seed-admin.mts <username> <password> [displayName]
 *
 * 需要 .env.local 有 FIREBASE_SERVICE_ACCOUNT_JSON。
 */
import admin from 'firebase-admin';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(plain, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

async function main() {
  const [username, password, displayName] = process.argv.slice(2);
  if (!username || !password) {
    console.error('用法：npx tsx --env-file=.env.local scripts/seed-admin.mts <username> <password> [displayName]');
    process.exit(1);
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    console.error('缺 FIREBASE_SERVICE_ACCOUNT_JSON（請確認 .env.local）');
    process.exit(1);
  }
  const sa = JSON.parse(saJson);
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  const db = admin.firestore();

  const dup = await db.collection('users').where('username', '==', username).limit(1).get();
  if (!dup.empty) {
    console.log(`帳號 ${username} 已存在，跳過。`);
    process.exit(0);
  }

  const passwordHash = await hashPassword(password);
  const ref = await db.collection('users').add({
    username,
    displayName: displayName || username,
    passwordHash,
    role: 'admin',
    createdAt: new Date(),
  });
  console.log(`已建 admin：${username}（id=${ref.id}）`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
