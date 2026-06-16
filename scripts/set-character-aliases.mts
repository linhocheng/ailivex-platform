/**
 * Migration: 為現有角色補 aliases 欄位
 * 用法：npx tsx --env-file=.env.local scripts/set-character-aliases.mts
 *
 * 會列出所有角色，並對已知角色自動補別名。
 * 未匹配的角色只印出名字，不動 Firestore。
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

// 手動解析 .env.local，因為 JSON 值裡有 " 讓 Node --env-file 解析失敗
function loadEnvLocal(): string {
  const envPath = new URL('../.env.local', import.meta.url).pathname;
  if (!fs.existsSync(envPath)) return '';
  const raw = fs.readFileSync(envPath, 'utf8');
  const match = raw.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m);
  if (!match) return '';
  let val = match[1].trim();
  // 若外層有引號，用 JSON 解析剝掉
  if (val.startsWith('"') && val.endsWith('"')) {
    try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
  }
  return val;
}

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || loadEnvLocal();
if (!SA_JSON) {
  console.error('需要 FIREBASE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

if (!getApps().length) {
  const sa = JSON.parse(SA_JSON);
  initializeApp({ credential: cert(sa), projectId: sa.project_id });
}

const db = getFirestore();

// ── 已知角色別名表 ──────────────────────────────────────────────
// key: 角色 name 包含這個關鍵字就套對應別名
const KNOWN_ALIASES: Record<string, string[]> = {
  '聖嚴': [
    '聖嚴', '聖嚴法師', '圣严', '圣严法师',
    '法師', '師父',
    'Sheng Yen', 'Master Sheng Yen',
  ],
  '達賴': [
    '達賴', '達賴喇嘛', '达赖', '达赖喇嘛',
    '喇嘛', '尊者',
    'Dalai Lama', 'His Holiness',
    '丹增嘉措', 'Tenzin Gyatso',
  ],
  '星雲': [
    '星雲', '星雲大師', '星云', '星云大师',
    '大師', '佛光山大師',
    'Hsing Yun', 'Master Hsing Yun',
  ],
};

function matchAliases(name: string): string[] | null {
  for (const [key, aliases] of Object.entries(KNOWN_ALIASES)) {
    if (name.includes(key)) return aliases;
  }
  return null;
}

async function main() {
  const snap = await db.collection('characters').get();
  console.log(`\n共 ${snap.size} 個角色：\n`);

  let updated = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const name: string = d.name || '(無名)';
    const existing: string[] = d.aliases || [];
    const aliases = matchAliases(name);

    if (!aliases) {
      console.log(`  [跳過] ${name} (${doc.id}) — 未知角色，請手動在 Admin UI 補別名`);
      continue;
    }

    if (JSON.stringify(existing.sort()) === JSON.stringify(aliases.slice().sort())) {
      console.log(`  [已有] ${name} — aliases 已正確，不重寫`);
      continue;
    }

    await doc.ref.update({ aliases });
    console.log(`  [更新] ${name} (${doc.id})`);
    console.log(`         別名：${aliases.join('、')}`);
    updated++;
  }

  console.log(`\n完成。更新了 ${updated} 個角色。`);
}

main().catch(e => { console.error(e); process.exit(1); });
