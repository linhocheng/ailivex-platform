import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type AccessDoc, type CharacterDoc } from '@/lib/collections';

export const runtime = 'nodejs';

// 用戶大廳：只回傳被指派、且 active 的角色
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const accessSnap = await db.collection(COL.access).where('userId', '==', user.uid).get();
  const charIds = accessSnap.docs.map(d => (d.data() as AccessDoc).characterId);
  if (charIds.length === 0) return NextResponse.json({ characters: [] });

  // Firestore in 查詢一次最多 30 個
  const chunks: string[][] = [];
  for (let i = 0; i < charIds.length; i += 30) chunks.push(charIds.slice(i, i + 30));

  const characters: Array<{ id: string; name: string; avatarUrl: string; hasVoice: boolean;
    lastTopic: string; lastAt: number | null }> = [];
  for (const chunk of chunks) {
    const snap = await db.collection(COL.characters)
      .where('__name__', 'in', chunk)
      .get();
    for (const d of snap.docs) {
      const c = d.data() as CharacterDoc;
      if (c.status !== 'active') continue;
      characters.push({
        id: d.id,
        name: c.name,
        avatarUrl: c.avatarUrl,
        hasVoice: !!c.voiceIdMinimax,
        lastTopic: '',
        lastAt: null,
      });
    }
  }

  // 「上次聊到」脈絡：發揮平台「記得您」的賣點，大廳卡片直接接上次的線。
  // lastSession.summary（語音收尾寫的）優先，沒有就拿最後一則訊息切片。
  await Promise.all(characters.map(async ch => {
    try {
      const conv = await db.collection(COL.conversations).doc(`${user.uid}_${ch.id}`).get();
      if (!conv.exists) return;
      const data = conv.data() as Record<string, unknown>;
      const ls = data.lastSession as { summary?: string } | undefined;
      const msgs = (data.messages as Array<{ content?: string; at?: number }> | undefined) || [];
      const lastMsg = msgs[msgs.length - 1];
      ch.lastTopic = (ls?.summary || lastMsg?.content || '').slice(0, 42);
      ch.lastAt = typeof lastMsg?.at === 'number' ? lastMsg.at : null;
    } catch { /* 脈絡拿不到不阻斷大廳 */ }
  }));

  return NextResponse.json({ characters });
}
