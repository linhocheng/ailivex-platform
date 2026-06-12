import { readFileSync } from 'fs';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const scryptAsync = promisify(scrypt);

const env = readFileSync('.env.local', 'utf8');
const SA_JSON = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON='([^']+)'/)?.[1];

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA_JSON)) });
}
const db = admin.firestore();

const password = process.argv[2] || 'ailiveX2026';
const salt = randomBytes(16).toString('hex');
const derived = await scryptAsync(password, salt, 64);
const passwordHash = salt + ':' + derived.toString('hex');

await db.collection('users').doc('mX56wM0CxRIMHlKgs2d0').update({ passwordHash });
console.log(`admin password reset to: ${password}`);
process.exit(0);
