import { getFirestore } from '../src/lib/firebase-admin.js';
const db = getFirestore();
const s = await db.collection('characters').where('name','==','張立').get();
s.docs.forEach(d => console.log(d.id, JSON.stringify({name:d.data().name, capabilities:d.data().capabilities})));
