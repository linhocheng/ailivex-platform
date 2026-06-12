/**
 * 指派檢查 —— 用戶能不能跟某角色互動。聊天/語音/文件路徑都先過這關，
 * 不靠前端隱藏（大廳不顯示 ≠ 後端擋住）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL } from '@/lib/collections';

export async function hasAccess(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<boolean> {
  if (!userId || !characterId) return false;
  const snap = await db.collection(COL.access).doc(`${userId}_${characterId}`).get();
  return snap.exists;
}
