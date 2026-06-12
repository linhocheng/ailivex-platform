import type { Firestore } from 'firebase-admin/firestore';
import { COL, type RelationshipDoc } from '@/lib/collections';

export async function upsertRelationship(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<void> {
  const id = `${userId}_${characterId}`;
  const ref = db.collection(COL.relationships).doc(id);
  const snap = await ref.get();
  const now = new Date();

  if (!snap.exists) {
    const doc: RelationshipDoc = {
      userId,
      characterId,
      conversationCount: 1,
      firstConversationAt: now,
      lastConversationAt: now,
    };
    await ref.set(doc);
  } else {
    await ref.update({
      conversationCount: (snap.data() as RelationshipDoc).conversationCount + 1,
      lastConversationAt: now,
    });
  }
}

export async function getRelationship(
  db: Firestore,
  userId: string,
  characterId: string,
): Promise<RelationshipDoc | null> {
  const id = `${userId}_${characterId}`;
  const snap = await db.collection(COL.relationships).doc(id).get();
  return snap.exists ? (snap.data() as RelationshipDoc) : null;
}
