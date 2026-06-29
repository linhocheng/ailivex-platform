import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type AccessDoc, type CharacterDoc } from '@/lib/collections';

export const runtime = 'nodejs';

// 素材轉換區：回傳用戶被指派且 active 的角色，含 voice 和 avatar 資訊
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getFirestore();
  const accessSnap = await db.collection(COL.access).where('userId', '==', user.uid).get();
  const charIds = accessSnap.docs.map(d => (d.data() as AccessDoc).characterId);
  if (charIds.length === 0) return NextResponse.json({ characters: [] });

  const chunks: string[][] = [];
  for (let i = 0; i < charIds.length; i += 30) chunks.push(charIds.slice(i, i + 30));

  const characters: Array<{
    id: string;
    name: string;
    avatarUrl: string;
    voiceId: string;
    heygenAvatarId: string;
  }> = [];

  for (const chunk of chunks) {
    const snap = await db.collection(COL.characters).where('__name__', 'in', chunk).get();
    for (const d of snap.docs) {
      const c = d.data() as CharacterDoc;
      if (c.status !== 'active') continue;
      characters.push({
        id: d.id,
        name: c.name,
        avatarUrl: c.avatarUrl || '',
        voiceId: c.voiceIdMinimax || '',
        heygenAvatarId: c.heygenAvatarId || '',
      });
    }
  }

  return NextResponse.json({ characters });
}
