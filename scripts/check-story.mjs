import { readFileSync } from 'fs';
import { resolve } from 'path';

// load .env.local manually
const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (!m) continue;
  let val = m[2].trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  env[m[1]] = val.replace(/\\n/g, '\n');
}

import('firebase-admin').then(async ({ default: admin }) => {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const story = await db.collection('tasks').doc('HNFgbIBI8EbGaY6jd5RL').get();
  const d = story.data();
  console.log('STORY status:', d.status, '| error:', d.error || '—');
  console.log('storyText length:', (d.storyText || '').length);

  const cards = await db.collection('tasks').where('parentTaskId', '==', 'HNFgbIBI8EbGaY6jd5RL').get();
  cards.docs
    .sort((a, b) => (a.data().order || 0) - (b.data().order || 0))
    .forEach(c => {
      const cd = c.data();
      console.log(`\n── card #${cd.order} [${cd.status}]`);
      console.log('  cardType:', cd.cardType);
      console.log('  cardText:', cd.cardText);
      console.log('  error:', cd.error || '—');
      console.log('  resultRef:', cd.resultRef || '—');
    });
  process.exit(0);
});
