import { NextResponse } from 'next/server';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { COL, type CharacterDoc, type VoiceSettings, type ConvSettings } from '@/lib/collections';
import { enhanceSoul } from '@/lib/soul';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  const db = getFirestore();
  const snap = await db.collection(COL.characters).orderBy('createdAt', 'desc').get();
  const characters = snap.docs.map(d => {
    const c = d.data() as CharacterDoc;
    return {
      id: d.id,
      name: c.name,
      avatarUrl: c.avatarUrl,
      status: c.status,
      hasSoulCore: !!c.soulCore,
      voiceIdMinimax: c.voiceIdMinimax || '',
      voiceSettings: c.voiceSettings || {},
    };
  });
  return NextResponse.json({ characters });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as {
    name?: string; soul?: string; soulCore?: string;
    avatarBase64?: string; avatarContentType?: string;
    voiceIdMinimax?: string; voiceSettings?: VoiceSettings; convSettings?: ConvSettings;
  } | null;

  const name = body?.name?.trim();
  const soul = body?.soul?.trim();
  if (!name || !soul || soul.length < 10)
    return NextResponse.json({ error: '角色名與靈魂（至少 10 字）必填' }, { status: 400 });

  const soulCore = body?.soulCore?.trim() || await enhanceSoul(name, soul);

  const db = getFirestore();
  const ref = db.collection(COL.characters).doc();

  let avatarUrl = '';
  if (body?.avatarBase64)
    avatarUrl = await uploadAvatar(ref.id, body.avatarBase64, body.avatarContentType || 'image/jpeg');

  const doc: CharacterDoc = {
    name, soul, soulCore, avatarUrl,
    voiceIdMinimax: body?.voiceIdMinimax?.trim() || '',
    voiceSettings: sanitizeVoiceSettings(body?.voiceSettings),
    convSettings: sanitizeConvSettings(body?.convSettings),
    status: 'active',
    createdAt: new Date(),
  };
  await ref.set(doc);
  return NextResponse.json({ id: ref.id, name, avatarUrl, soulCore });
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
  const c15 = (n: number) => Math.max(1, Math.min(5, Math.round(n)));
  const out: ConvSettings = {};
  if (typeof cs.responseSpeed === 'number') out.responseSpeed = c15(cs.responseSpeed);
  if (typeof cs.interruptSensitivity === 'number') out.interruptSensitivity = c15(cs.interruptSensitivity);
  if (typeof cs.imThreshold === 'number') out.imThreshold = c15(cs.imThreshold);
  if (typeof cs.interruptThreshold === 'number') out.interruptThreshold = c15(cs.interruptThreshold);
  if (typeof cs.temperature === 'number') out.temperature = Math.max(0.1, Math.min(1.0, cs.temperature));
  return out;
}
