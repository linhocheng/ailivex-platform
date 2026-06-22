/**
 * GET /api/brands/[characterId]/products
 * 用戶端讀取品牌產品圖列表（需有角色存取權）
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { COL } from '@/lib/collections';

export const runtime = 'nodejs';

type Params = { params: Promise<{ characterId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { characterId } = await params;
  const db = getFirestore();

  const ok = user.role === 'admin' || (await hasAccess(db, user.uid, characterId));
  if (!ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const snap = await db.collection(COL.brandProducts)
    .where('characterId', '==', characterId)
    .orderBy('createdAt', 'desc')
    .get();

  const products = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name as string,
      imageUrl: data.imageUrl as string,
      tags: (data.tags as string[]) ?? [],
    };
  });

  return NextResponse.json({ products });
}
