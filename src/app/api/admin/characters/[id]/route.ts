import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { COL, type CharacterDoc, type VoiceSettings, type ConvSettings, type TaskCapability } from '@/lib/collections';

const ALL_CAPABILITIES: TaskCapability[] = ['image_generation', 'audio_generation', 'writing', 'web_search'];
import { enhanceSoul } from '@/lib/soul';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

// 讀單一角色完整資料
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getFirestore();
  const snap = await db.collection(COL.characters).doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const c = snap.data() as CharacterDoc;
  return NextResponse.json({
    id,
    name: c.name,
    soul: c.soul || '',
    soulCore: c.soulCore || '',
    voiceIdMinimax: c.voiceIdMinimax || '',
    voiceSettings: c.voiceSettings || {},
    convSettings: c.convSettings || {},
    aliases: c.aliases || [],
    capabilities: c.capabilities || [],
    avatarUrl: c.avatarUrl || '',
    status: c.status,
  });
}

// 編輯角色
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as {
    name?: string; soul?: string; soulCore?: string;
    voiceIdMinimax?: string; voiceSettings?: VoiceSettings;
    convSettings?: ConvSettings; aliases?: string[];
    capabilities?: TaskCapability[];
    avatarBase64?: string; avatarContentType?: string;
    reEnhance?: boolean;
  } | null;

  if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });

  const db = getFirestore();
  const ref = db.collection(COL.characters).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  const existing = snap.data() as CharacterDoc;
  const updates: Partial<CharacterDoc> = {};

  const name = body?.name?.trim();
  const soul = body?.soul?.trim();

  if (name) updates.name = name;
  if (soul) updates.soul = soul;
  if (body?.voiceIdMinimax !== undefined) updates.voiceIdMinimax = body.voiceIdMinimax.trim();
  if (body?.voiceSettings !== undefined) updates.voiceSettings = sanitizeVoiceSettings(body.voiceSettings);
  if (body?.convSettings !== undefined) updates.convSettings = sanitizeConvSettings(body.convSettings);
  if (Array.isArray(body?.aliases)) updates.aliases = body.aliases.map(s => s.trim()).filter(Boolean);
  if (Array.isArray(body?.capabilities)) updates.capabilities = body.capabilities.filter(c => ALL_CAPABILITIES.includes(c));

  // 重新提煉 soulCore
  if (body?.soulCore?.trim()) {
    updates.soulCore = body.soulCore.trim();
  } else if (body?.reEnhance && soul) {
    updates.soulCore = await enhanceSoul(name || existing.name, soul);
  }

  // 換頭像
  if (body?.avatarBase64) {
    updates.avatarUrl = await uploadAvatar(id, body.avatarBase64, body.avatarContentType || 'image/jpeg');
  }

  await ref.update(updates as Record<string, unknown>);
  return NextResponse.json({ ok: true, ...updates });
}

// 刪除角色（同時清 access）
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });

  const db = getFirestore();

  // 刪 access 記錄
  const accessSnap = await db.collection(COL.access)
    .where('characterId', '==', id).get();
  const batch = db.batch();
  accessSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db.collection(COL.characters).doc(id));
  await batch.commit();

  return NextResponse.json({ ok: true });
}

function sanitizeVoiceSettings(vs?: VoiceSettings): VoiceSettings {
  if (!vs) return {};
  const out: VoiceSettings = {};
  if (typeof vs.speed === 'number') out.speed = Math.max(0.5, Math.min(2.0, vs.speed));
  if (typeof vs.pitch === 'number') out.pitch = Math.max(-12, Math.min(12, vs.pitch));
  if (typeof vs.vol === 'number') out.vol = Math.max(0.1, Math.min(3.0, vs.vol));
  if (typeof vs.emotion === 'string') out.emotion = vs.emotion;
  return out;
}

function sanitizeConvSettings(cs?: ConvSettings): ConvSettings {
  if (!cs) return {};
  const clamp15 = (n: number) => Math.max(1, Math.min(5, Math.round(n)));
  const out: ConvSettings = {};
  if (typeof cs.responseSpeed === 'number') out.responseSpeed = clamp15(cs.responseSpeed);
  if (typeof cs.interruptSensitivity === 'number') out.interruptSensitivity = clamp15(cs.interruptSensitivity);
  if (typeof cs.imThreshold === 'number') out.imThreshold = clamp15(cs.imThreshold);
  if (typeof cs.interruptThreshold === 'number') out.interruptThreshold = clamp15(cs.interruptThreshold);
  if (typeof cs.temperature === 'number') out.temperature = Math.max(0.1, Math.min(1.0, cs.temperature));
  return out;
}

async function uploadAvatar(charId: string, base64: string, contentType: string): Promise<string> {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return '';
  const raw = base64.includes(',') ? base64.split(',')[1] : base64;
  const buf = Buffer.from(raw, 'base64');
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const bucket = getFirebaseAdmin().storage().bucket(bucketName);
  const file = bucket.file(`characters/${charId}/avatar.${ext}`);
  await file.save(buf, { contentType, resumable: false });
  return `https://storage.googleapis.com/${bucketName}/characters/${charId}/avatar.${ext}`;
}
