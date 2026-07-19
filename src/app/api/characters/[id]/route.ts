import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { COL, GPT_VOICE_LINE, type CharacterDoc, type AccessDoc } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = getFirestore();

  if (user.role !== 'admin' && !(await hasAccess(db, user.uid, id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const snap = await db.collection(COL.characters).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  // GPT Voice 線按鈕開關：線退役時對所有人隱藏；現役時 admin 恆可、一般用戶看
  // access.gptVoiceEnabled（token route 會再驗一次，UI 隱藏不是安全）
  let gptVoice = !GPT_VOICE_LINE.retired && user.role === 'admin';
  if (!gptVoice && !GPT_VOICE_LINE.retired) {
    try {
      const acc = await db.collection(COL.access).doc(`${user.uid}_${id}`).get();
      gptVoice = acc.exists && !!(acc.data() as AccessDoc).gptVoiceEnabled;
    } catch { /* 旗標拿不到就不顯示按鈕 */ }
  }

  const c = snap.data() as CharacterDoc;
  // 訓練線（共創）按鈕：admin＋角色共創旗標；一般用戶永遠看不到（token route 會再驗）
  const trainerVoice = user.role === 'admin' && !!c.methodProposalEnabled;
  return NextResponse.json({
    id,
    name: c.name || '',
    avatarUrl: c.avatarUrl || '',
    hasVoice: !!(c.voiceIdMinimax),
    gptVoice,
    trainerVoice,
  });
}
