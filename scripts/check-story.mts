import admin from 'firebase-admin';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

async function main() {
  const story = await db.collection('tasks').doc('HNFgbIBI8EbGaY6jd5RL').get();
  const d = story.data()!;
  console.log('STORY status:', d.status, '| error:', d.error ?? '—');
  console.log('storyText len:', (d.storyText || '').length);

  const cards = await db.collection('tasks').where('parentTaskId', '==', 'HNFgbIBI8EbGaY6jd5RL').get();
  cards.docs
    .sort((a, b) => (a.data().order || 0) - (b.data().order || 0))
    .forEach(c => {
      const cd = c.data();
      console.log(`\ncard #${cd.order} [${cd.status}] | cardType: ${cd.cardType}`);
      console.log('  cardText:', cd.cardText);
      console.log('  error:', cd.error ?? '—');
      console.log('  resultRef:', cd.resultRef ?? '—');
    });
}
main().catch(console.error).finally(() => process.exit(0));
