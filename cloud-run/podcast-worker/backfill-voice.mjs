import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const env = readFileSync('/Users/adamlin/.ailive/ailivex-platform/.env.local', 'utf8');
writeFileSync(join(tmpdir(), 'zhu-duo-sa.json'), env.match(/FIREBASE_SERVICE_ACCOUNT_JSON=['"]?(\{.*\})['"]?/)[1]);
process.env.GOOGLE_APPLICATION_CREDENTIALS = join(tmpdir(), 'zhu-duo-sa.json');
process.env.FIREBASE_PROJECT_ID = 'ailivex-2026';
process.env.JOB_MODE = '1'; process.env.BRIDGE_URL = 'https://x.invalid'; process.env.BRIDGE_SECRET = 'x';
const { db } = await import('./dist/index.js');

const VOICES = {
  nL8NgpkXZ7afqQSOl4cm: { // 簡報王(打動人心)
    rhythm: '短。急。句子常常沒講完就換一個。很少講超過三句話不換氣。',
    habits: '愛用學員的名字、數字、第幾分鐘。開場常常直接切入，不鋪陳。',
    evidenceStyle: '他不打比方，他舉例子。要嘛給你一個具體的人和當下發生的事，要嘛不給。',
    whenUncertain: '直接說「我不知道」然後停住。他不填空。',
    forbiddenRegister: '不用心理學術語。他是教技術的，不是教內在的。',
  },
  FvuTQklp77Fyn8iA3pI5: { // tracy
    rhythm: '慢。會停。問句多，但不是修辭性的，是真的在等答案。',
    habits: '常常先問一個問題，然後閉嘴。她允許沉默。',
    evidenceStyle: '她講現場——那天誰說了什麼、誰的臉色變了。她講觀察，不講原理。',
    whenUncertain: '她會說「我不確定，我只知道我看到什麼」。',
    forbiddenRegister: '不用能量、頻率、共振這類詞。她是教練，不是靈性導師。',
  },
};
for (const [id, voice] of Object.entries(VOICES)) {
  await db.collection('characters').doc(id).update({ voice });
  const name = (await db.collection('characters').doc(id).get()).data().name;
  console.log(`voice 回填 ✓ ${name}`);
}
process.exit(0);
