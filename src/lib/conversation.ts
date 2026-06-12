/**
 * 對話讀寫 —— 綁 (用戶 × 角色)，docId 用確定性 `${userId}_${characterId}`。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COL, type ConversationDoc, type ChatMessage } from '@/lib/collections';

const HISTORY_LIMIT = 24; // 保留最近幾則進 context

export function convId(userId: string, characterId: string) {
  return `${userId}_${characterId}`;
}

export async function loadHistory(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<ChatMessage[]> {
  const snap = await db.collection(COL.conversations).doc(convId(userId, characterId)).get();
  if (!snap.exists) return [];
  const data = snap.data() as ConversationDoc;
  const msgs = data.messages || [];
  return msgs.slice(-HISTORY_LIMIT);
}

export async function appendMessages(
  db: Firestore,
  userId: string,
  characterId: string,
  newMsgs: ChatMessage[],
): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore');
  const ref = db.collection(COL.conversations).doc(convId(userId, characterId));
  const snap = await ref.get();
  if (!snap.exists) {
    const doc: ConversationDoc = {
      userId,
      characterId,
      messages: newMsgs,
      messageCount: newMsgs.length,
      updatedAt: new Date(),
    };
    await ref.set(doc);
  } else {
    await ref.update({
      messages: FieldValue.arrayUnion(...newMsgs),
      messageCount: FieldValue.increment(newMsgs.length),
      updatedAt: new Date(),
    });
  }
}
