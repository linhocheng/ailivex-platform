/**
 * 用量管制 — 總量制（user 層，全角色共用一桶）
 *
 * 三個執法點都從這裡走（收斂點）：
 *   語音開始前  → checkVoiceQuota（livekit/token）
 *   語音進行中  → addVoiceSeconds（agent heartbeat，Phase 2）
 *   文件生成    → consumeDocQuota / refundDocQuota（createDocumentJob / doc-process）
 *
 * 天條：計數、判斷全是程式；used 只加不減，limit 缺省 = 不限。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { COL, type UserDoc } from '@/lib/collections';

export interface QuotaSnapshot {
  voiceSecondsLimit: number | null;   // null = 不限
  voiceSecondsUsed: number;
  voiceSecondsRemaining: number | null;
  docsLimit: number | null;
  docsUsed: number;
  docsRemaining: number | null;
  mediaLimit: number | null;
  mediaUsed: number;
  mediaRemaining: number | null;
  textLimit: number | null;
  textUsed: number;
  textRemaining: number | null;
}

export class QuotaExceededError extends Error {
  kind: 'voice' | 'docs' | 'media' | 'text';
  constructor(kind: 'voice' | 'docs' | 'media' | 'text') {
    super(`${kind}_quota_exhausted`);
    this.kind = kind;
  }
}

function toSnapshot(u: Partial<UserDoc> | undefined): QuotaSnapshot {
  const vLimit = typeof u?.voiceSecondsLimit === 'number' ? u.voiceSecondsLimit : null;
  const vUsed = Number(u?.voiceSecondsUsed || 0);
  const dLimit = typeof u?.docsLimit === 'number' ? u.docsLimit : null;
  const dUsed = Number(u?.docsUsed || 0);
  const mLimit = typeof u?.mediaLimit === 'number' ? u.mediaLimit : null;
  const mUsed = Number(u?.mediaUsed || 0);
  const tLimit = typeof u?.textLimit === 'number' ? u.textLimit : null;
  const tUsed = Number(u?.textUsed || 0);
  return {
    voiceSecondsLimit: vLimit,
    voiceSecondsUsed: vUsed,
    voiceSecondsRemaining: vLimit === null ? null : Math.max(0, vLimit - vUsed),
    docsLimit: dLimit,
    docsUsed: dUsed,
    docsRemaining: dLimit === null ? null : Math.max(0, dLimit - dUsed),
    mediaLimit: mLimit,
    mediaUsed: mUsed,
    mediaRemaining: mLimit === null ? null : Math.max(0, mLimit - mUsed),
    textLimit: tLimit,
    textUsed: tUsed,
    textRemaining: tLimit === null ? null : Math.max(0, tLimit - tUsed),
  };
}

export async function getQuota(db: Firestore, userId: string): Promise<QuotaSnapshot> {
  const snap = await db.collection(COL.users).doc(userId).get();
  return toSnapshot(snap.data() as UserDoc | undefined);
}

// 語音開始前的閘：剩餘 <= 0 → 擋。回傳 snapshot 給 caller 塞 metadata（agent 用）。
export async function checkVoiceQuota(db: Firestore, userId: string): Promise<QuotaSnapshot> {
  const q = await getQuota(db, userId);
  if (q.voiceSecondsRemaining !== null && q.voiceSecondsRemaining <= 0) {
    throw new QuotaExceededError('voice');
  }
  return q;
}

// 語音計量：agent heartbeat / 掛斷結算呼叫，只加不減
export async function addVoiceSeconds(db: Firestore, userId: string, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await db.collection(COL.users).doc(userId).update({
    voiceSecondsUsed: FieldValue.increment(Math.round(seconds)),
  });
}

// 文件扣量：transaction 內查+扣原子完成（防並發雙扣）。額度滿丟 QuotaExceededError。
export async function consumeDocQuota(db: Firestore, userId: string): Promise<void> {
  const ref = db.collection(COL.users).doc(userId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const q = toSnapshot(snap.data() as UserDoc | undefined);
    if (q.docsRemaining !== null && q.docsRemaining <= 0) {
      throw new QuotaExceededError('docs');
    }
    tx.update(ref, { docsUsed: FieldValue.increment(1) });
  });
}

// 文件退量：生成 failed 時退 1（不讓失敗吃額度）；地板 0
export async function refundDocQuota(db: Firestore, userId: string): Promise<void> {
  const ref = db.collection(COL.users).doc(userId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const used = Number((snap.data() as UserDoc | undefined)?.docsUsed || 0);
    if (used > 0) tx.update(ref, { docsUsed: used - 1 });
  }).catch(() => { /* 退量失敗不阻斷主流程 */ });
}

// 媒體扣量（圖片/影片/音檔）：transaction 內查+扣原子完成（防並發雙扣）。額度滿丟 QuotaExceededError。
// count>1 用於 fan-out（如故事板一次生 N 張圖）：一個 transaction 內驗總量夠不夠再一次扣 N。
export async function consumeMediaQuota(db: Firestore, userId: string, count = 1): Promise<void> {
  if (!userId || count <= 0) return;
  const ref = db.collection(COL.users).doc(userId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const q = toSnapshot(snap.data() as UserDoc | undefined);
    if (q.mediaRemaining !== null && q.mediaRemaining < count) {
      throw new QuotaExceededError('media');
    }
    tx.update(ref, { mediaUsed: FieldValue.increment(count) });
  });
}

// 文字對話扣量：每則 user 訊息扣 1。transaction 內查+扣原子完成。額度滿丟 QuotaExceededError。
// 回傳扣完後的剩餘則數（null = 不限），給對話頁顯示指引。
export async function consumeTextQuota(db: Firestore, userId: string): Promise<number | null> {
  if (!userId) return null;
  const ref = db.collection(COL.users).doc(userId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const q = toSnapshot(snap.data() as UserDoc | undefined);
    if (q.textRemaining !== null && q.textRemaining <= 0) {
      throw new QuotaExceededError('text');
    }
    tx.update(ref, { textUsed: FieldValue.increment(1) });
    return q.textRemaining === null ? null : q.textRemaining - 1;
  });
}

// 文字對話退量：LLM 呼叫失敗時退 1（不讓失敗吃額度）；地板 0
export async function refundTextQuota(db: Firestore, userId: string): Promise<void> {
  if (!userId) return;
  const ref = db.collection(COL.users).doc(userId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const used = Number((snap.data() as UserDoc | undefined)?.textUsed || 0);
    if (used > 0) tx.update(ref, { textUsed: used - 1 });
  }).catch(() => { /* 退量失敗不阻斷主流程 */ });
}

// 媒體退量：生成 failed 時退回（不讓失敗吃額度）；地板 0
export async function refundMediaQuota(db: Firestore, userId: string, count = 1): Promise<void> {
  if (!userId || count <= 0) return;
  const ref = db.collection(COL.users).doc(userId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const used = Number((snap.data() as UserDoc | undefined)?.mediaUsed || 0);
    const next = Math.max(0, used - count);
    if (next !== used) tx.update(ref, { mediaUsed: next });
  }).catch(() => { /* 退量失敗不阻斷主流程 */ });
}
