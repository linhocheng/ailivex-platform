// 第三期驗證：遺忘曲線＋gist 化＋去重放鬆（真模組＋真 Firestore＋測試配對 zhu-test-gist，收尾全清）
// 鑑別信號（宣告修好前先寫下——只有做對才會出現）：
//   ①遺忘曲線（純函數）：同齡 45 天，emotion imp8 門檻 56d 不歸檔、fact imp3 門檻 35d 歸檔——公式錯不會分岔
//   ②gist：合成 40 天前的長 archive 情節 → runGistPass 後 content 變短、rawContent=原文、gistedAt 有值；
//     dryRun 時三欄位全不動
//   ③去重放鬆：fact 逐字重複仍被擋（true）、同義重述放行（false）；emotion 重述維持舊嚴格門檻被擋
// 用法：npx tsx scripts/_zhu_verify_forgetting.ts
import { readFileSync } from 'fs';
import admin from 'firebase-admin';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.GIST_CANARY_USERS = 'zhu-test-gist';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();

const U = 'zhu-test-gist';
const C = 'test-char-gist';

async function cleanup() {
  const snap = await db.collection('memories').where('userId', '==', U).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `　${extra}` : ''}`);
  ok ? pass++ : fail++;
}

(async () => {
  const { emotionalWeightOf, effectiveDays, runGistPass } = await import('../src/lib/forgetting');
  const { writeMemory } = await import('../src/lib/memory');
  const { getAnthropicClient } = await import('../src/lib/anthropic-via-bridge');

  // ─── ① 遺忘曲線純函數 ───
  const wEmotion = emotionalWeightOf({ type: 'emotion', importance: 8 });   // 0.4 + 0.48 = 0.88
  const wFact = emotionalWeightOf({ type: 'fact', importance: 3 });         // 0.18
  const age = 45;
  const emotionSurvives = age < effectiveDays(30, wEmotion); // 56.4d
  const factArchives = age > effectiveDays(30, wFact);       // 35.4d
  check('①遺忘曲線分岔', emotionSurvives && factArchives,
    `emotion(w=${wEmotion.toFixed(2)}) 門檻 ${effectiveDays(30, wEmotion).toFixed(1)}d 存活；fact(w=${wFact.toFixed(2)}) 門檻 ${effectiveDays(30, wFact).toFixed(1)}d 歸檔`);

  // ─── ② gist 化 ───
  await cleanup();
  const longContent = '用戶在陽明山經營一間家庭式咖啡館，主打手沖耶加雪菲，每週三固定公休帶女兒去士林夜市吃蚵仔煎，他說那是跟過世的父親最深的共同回憶，父親生前每個月都帶他去同一攤，攤位老闆娘到現在還記得他小時候的樣子。';
  const ref = await db.collection('memories').add({
    userId: U, characterId: C, content: longContent, type: 'fact', tier: 'archive',
    status: 'active', importance: 6, hitCount: 0, lastHitAt: null, source: 'extraction',
    createdAt: new Date(Date.now() - 40 * 86400_000),
  });
  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY!, { bridgeTimeoutMs: 120_000 });

  // dryRun：不寫
  const dry = await runGistPass(db, client, { dryRun: true });
  const afterDry = (await ref.get()).data()!;
  check('②a dryRun 不動資料', dry.candidates === 1 && !afterDry.rawContent && afterDry.content === longContent,
    `candidates=${dry.candidates} gisted(計畫)=${dry.gisted}`);

  // 真跑：蓋大意留原文
  const wet = await runGistPass(db, client, {});
  const after = (await ref.get()).data()!;
  check('②b gist 蓋 content＋原文留 rawContent＋gistedAt',
    wet.gisted === 1 && after.rawContent === longContent
    && after.content.length < longContent.length * 0.8 && !!after.gistedAt
    && Array.isArray(after.embedding) && after.embedding.length > 0,
    `原文 ${longContent.length} 字 → 大意 ${after.content?.length} 字：「${after.content}」`);

  // 冪等：已 gist 過不再是候選
  const again = await runGistPass(db, client, { dryRun: true });
  check('②c 已 gist 不重複處理', again.candidates === 0, `candidates=${again.candidates}`);

  // ─── ③ 去重放鬆 ───
  await cleanup();
  await writeMemory(db, U, C, '他在台積電上班，負責先進製程的良率分析', { type: 'fact' });
  await writeMemory(db, U, C, '他在台積電上班，負責先進製程的良率分析', { type: 'fact' }); // 逐字重複
  await writeMemory(db, U, C, '用戶提到自己任職於台積電，工作內容是分析製程數據', { type: 'fact' }); // 同義重述
  const facts = await db.collection('memories').where('userId', '==', U).where('type', '==', 'fact').get();
  check('③a fact 逐字擋、重述放行（2 條）', facts.size === 2, `寫入 ${facts.size} 條`);

  await writeMemory(db, U, C, '聊到父親時他聲音變低，說很想念他', { type: 'emotion' });
  await writeMemory(db, U, C, '聊到父親的時候他聲音變低了，說自己很想念他', { type: 'emotion' }); // 近逐字（舊門檻該擋）
  const emos = await db.collection('memories').where('userId', '==', U).where('type', '==', 'emotion').get();
  check('③b emotion 維持嚴格（1 條）', emos.size === 1, `寫入 ${emos.size} 條`);

  await cleanup();
  console.log(`\n${fail === 0 ? '全綠' : '有紅'}：${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
