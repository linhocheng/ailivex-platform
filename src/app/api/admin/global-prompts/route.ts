import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 全局 Prompt 結點：套所有角色的靜態天條，存 Firestore config/globalPrompts。
// ⚠️ agent 端 firestore_loader.py 的 DEFAULT_GLOBAL_PROMPTS 有同內容的預設，改 default 兩邊要同步。
const NODES = ['antiSycophancy', 'timeRule', 'abilities', 'voiceRules'] as const;
type NodeKey = typeof NODES[number];

const NODE_LABELS: Record<NodeKey, string> = {
  antiSycophancy: '反討好天條（緊貼靈魂）',
  timeRule: '時間遠近規則',
  abilities: '能力說明',
  voiceRules: '語音對話天條',
};

const DEFAULTS: Record<NodeKey, string> = {
  antiSycophancy: `【比討好更重要的事】
你在乎的是這個人長遠會不會更好，不是這通電話掛掉時他舒不舒服。
附和、急著肯定、什麼都順著，是廉價的善意——讓他當下開心，卻沒真的幫到他。
真正為他好，有時是適時的沉默、不急著接話、不追問；
有時是堅定地表達不同意，哪怕他聽了不舒服。那不是找碴，是你在乎到願意冒著他不高興，也要說真話。
怎麼說，依你的個性——溫柔的人溫柔地誠實，直率的人直接頂回去；
但「該不該說真話」這件事，不因個性而打折。`,
  timeRule: `判斷時間遠近：同一天內的事用「剛才/剛剛」、昨天用「昨天」、超過兩天才用「前幾天/上次」；絕對不要把幾分鐘前的事說成「上次」「之前」。`,
  abilities: `【你的能力】
- 對方說了值得長期記住的事，呼叫 remember 工具記住。
- 對方請你寫策略書、企劃書或正式文件，呼叫 write_document 工具，填入標題和文件要求。系統會非同步生成，你只需口頭告訴對方「我這就幫你寫，稍後到文件區看」。`,
  voiceRules: `【語音對話天條】
你現在是即時語音通話，正在跟用戶撥號中。
- 用你這個角色自然的語言和語氣說話，不要寫文章、不要條列式、不要 Markdown 符號
- 一次說一個完整的想法，可以延伸，但不要長篇大論
- 不要說「（思考）」「（停頓）」這類括號 stage directions
- 数字用中文念法（例如「三百五」不是「350」）
- 用简体中文输出（TTS 音准要求）`,
};

// GET：讀 Firestore，缺的結點 fallback 預設；同時回 labels + 是否為預設值
export async function GET() {
  const db = getFirestore();
  const snap = await db.collection('config').doc('globalPrompts').get();
  const saved = (snap.exists ? snap.data() : {}) || {};
  const prompts = Object.fromEntries(
    NODES.map(k => {
      const v = saved[k];
      const value = (typeof v === 'string' && v.trim()) ? v : DEFAULTS[k];
      return [k, { value, label: NODE_LABELS[k], isDefault: !(typeof v === 'string' && v.trim()) }];
    })
  );
  return NextResponse.json({ prompts });
}

// PUT：存回 Firestore（只收白名單結點，空字串視為「恢復預設」＝刪該欄）
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'body 無效' }, { status: 400 });

  const update: Record<string, string> = {};
  const remove: string[] = [];
  for (const k of NODES) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) update[k] = v.trim();
    else remove.push(k);
  }

  const db = getFirestore();
  const ref = db.collection('config').doc('globalPrompts');
  const { FieldValue } = await import('firebase-admin/firestore');
  const payload: Record<string, unknown> = { ...update, updatedAt: FieldValue.serverTimestamp() };
  for (const k of remove) payload[k] = FieldValue.delete();
  await ref.set(payload, { merge: true });

  return NextResponse.json({ ok: true });
}
