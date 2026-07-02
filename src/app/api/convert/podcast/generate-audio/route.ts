/**
 * POST /api/convert/podcast/generate-audio
 * Phase 2：角色自貼情緒標記 → 逐行 TTS → 合併 MP3 → 上傳 GCS
 * Body: { taskId: string; script?: PodcastLine[] }
 * Returns: { audioUrl: string }
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore, getFirebaseAdmin } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, type CharacterDoc, type TaskDoc, type PodcastLine } from '@/lib/collections';
import { normalizeTTSText } from '@/lib/tts-normalize';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

export const runtime = 'nodejs';
export const maxDuration = 300;

const BRIDGE_BASE = cleanUrl((process.env.BRIDGE_URL ?? '').replace(/\/v1\/messages\/?$/, ''));
const BRIDGE_ENDPOINT = `${BRIDGE_BASE}/v1/messages`;
const BRIDGE_SECRET = cleanSecret(process.env.BRIDGE_SECRET);

const VALID_INTERJECTION = new Set(['emm', 'breath', 'sighs', 'chuckle', 'inhale', 'exhale', 'gasps']);

function sanitizeTags(text: string): string {
  return text
    .replace(/\(([^)]+)\)/g, (m, inner) =>
      VALID_INTERJECTION.has(inner.trim()) ? m : '')
    .replace(/<([^>]+)>/g, (m, inner) =>
      /^#[\d.]+#$/.test(inner.trim()) ? m : '');
}

async function tagLinesForCharacter(
  character: { name: string; soul: string; soulCore?: string },
  lines: string[],
): Promise<string[]> {
  if (lines.length === 0) return [];

  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

  const res = await fetch(BRIDGE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BRIDGE_SECRET },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `${character.soulCore || character.soul}

以下是你在一場對話裡說的話。請為每一句加上聲音標記，讓語音聽起來像你平時說話的樣子，不是在表演。

可用標記（只能用這些，不能自創）：
語氣標記：
  (emm)    — 「嗯……」遲疑猶豫，想法還沒整理好
  (breath) — 輕吸氣，準備說話或換氣
  (sighs)  — 嘆氣，有點無奈或感嘆
  (chuckle)— 輕笑，帶一點幽默或放鬆
  (inhale) — 急促吸氣，驚訝或激動
  (exhale) — 呼氣，釋放情緒或鬆了口氣
  (gasps)  — 驚呼吸氣，強烈驚訝
停頓標記：
  <#0.3#>  — 短停（0.3秒）：換氣、語氣轉折
  <#0.5#>  — 中停（0.5秒）：思考、強調前後
  <#1.0#>  — 長停（1秒）：重大轉折、情緒醞釀

規則：
- 台詞的文字內容絕對不能修改，只能在台詞中插入標記
- 標記要符合你自己的個性，不要硬套、不要過度（一句話最多 1-2 個標記）
- (sighs) 嘆氣聲整集最多用 1 次，用太多會讓聽眾覺得你在抱怨
- 輸出格式：與輸入完全對應，每行保留原編號，不加任何說明或前後文`,
      messages: [{
        role: 'user',
        content: `以下是你（${character.name}）在這集 Podcast 裡的台詞。請為每一行加上符合你個性的聲音標記：

${numbered}

請直接輸出加完標記的台詞，格式與輸入相同（保留編號），不加其他說明。`,
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bridge tagging ${res.status}: ${errText.slice(0, 100)}`);
  }

  const data = await res.json();
  const raw: string = data.content?.[0]?.text ?? '';

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const pattern = new RegExp(`^${i + 1}[.、．]\\s*(.+)`, 'm');
    const match = raw.match(pattern);
    const tagged = match ? match[1].trim() : lines[i];
    result.push(sanitizeTags(tagged));
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function ttsToBuffer(text: string, voiceId: string, speed = 1.05): Promise<Buffer> {
  const apiKey = process.env.MINIMAX_API_KEY!;
  const groupId = process.env.MINIMAX_GROUP_ID!;
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'speech-2.8-hd',
      text: normalizeTTSText(text),
      stream: true,
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: { voice_id: voiceId, speed, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });

  if (!res.ok || !res.body) throw new Error(`MiniMax TTS ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: Uint8Array[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = event.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const jsonText = dataLine.slice(5).trim();
      if (!jsonText || jsonText === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonText);
        const audioHex: string = parsed?.data?.audio;
        if (audioHex && parsed?.data?.status === 1) chunks.push(hexToBytes(audioHex));
      } catch { /* skip */ }
    }
  }

  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

async function uploadToGCS(taskId: string, buffer: Buffer): Promise<string> {
  const admin = getFirebaseAdmin();
  const bucket = admin.storage().bucket();
  const file = bucket.file(`podcast/${taskId}.mp3`);
  await file.save(buffer, { metadata: { contentType: 'audio/mpeg' }, resumable: false });
  return `https://storage.googleapis.com/${bucket.name}/podcast/${taskId}.mp3`;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    taskId?: string;
    script?: PodcastLine[];
  };

  const taskId = (body.taskId ?? '').trim();
  if (!taskId) return NextResponse.json({ error: 'taskId 必填' }, { status: 400 });

  const db = getFirestore();
  const taskSnap = await db.collection(COL.tasks).doc(taskId).get();
  if (!taskSnap.exists) return NextResponse.json({ error: 'task not found' }, { status: 404 });

  const task = taskSnap.data() as TaskDoc;
  if (task.userId !== user.uid) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (task.type !== 'podcast_generation') return NextResponse.json({ error: 'not a podcast task' }, { status: 400 });

  // 用傳入的 script（已編輯），否則讀 Firestore
  const script: PodcastLine[] = body.script?.length ? body.script : (task.podcastScript ?? []);
  if (script.length === 0) return NextResponse.json({ error: '尚未有腳本' }, { status: 400 });

  // 若 script 有更新，寫回 Firestore
  if (body.script?.length) {
    await taskSnap.ref.update({ podcastScript: script });
  }

  await taskSnap.ref.update({ status: 'running', podcastPhase: 'audio_pending' });

  try {
    const characterIds = [...new Set(script.map(l => l.characterId))];
    const charSnaps = await Promise.all(characterIds.map(id => db.collection(COL.characters).doc(id).get()));

    const charMap: Record<string, { name: string; soul: string; soulCore?: string; voiceId: string }> = {};
    for (const snap of charSnaps) {
      if (!snap.exists) continue;
      const c = snap.data() as CharacterDoc;
      charMap[snap.id] = { name: c.name, soul: c.soul, soulCore: c.soulCore, voiceId: c.voiceIdMinimax ?? '' };
    }

    // 角色自貼情緒標記（每角色只看自己的台詞）
    const charLineGroups = new Map<string, { indices: number[]; texts: string[] }>();
    for (let i = 0; i < script.length; i++) {
      const { characterId } = script[i];
      if (!charLineGroups.has(characterId)) charLineGroups.set(characterId, { indices: [], texts: [] });
      const group = charLineGroups.get(characterId)!;
      group.indices.push(i);
      group.texts.push(script[i].text);
    }

    const taggedTexts: string[] = script.map(l => l.text);
    for (const [charId, { indices, texts }] of charLineGroups) {
      const char = charMap[charId];
      if (!char) continue;
      const tagged = await tagLinesForCharacter(char, texts);
      console.log(`[podcast-tag] ${char.name} (${indices.length} 行)`);
      indices.forEach((scriptIdx, groupIdx) => {
        const orig = script[scriptIdx].text;
        const res = tagged[groupIdx] ?? orig;
        if (res !== orig) console.log(`  [${scriptIdx}] ${orig}\n       → ${res}`);
        taggedTexts[scriptIdx] = res;
      });
    }

    // 換人說話前插入停頓
    const finalTexts = taggedTexts.map((text, i) => {
      const sameSpeaker = i > 0 && script[i].characterId === script[i - 1].characterId;
      const pause = i === 0 ? '' : sameSpeaker ? '<#0.3#>' : '<#0.5#>';
      return `${pause}${text}`;
    });

    // 逐行 TTS
    const audioBuffers: Buffer[] = [];
    for (let i = 0; i < script.length; i++) {
      const voiceId = charMap[script[i].characterId]?.voiceId;
      if (!voiceId) throw new Error(`角色 ${script[i].speaker} 沒有設定聲音（voiceIdMinimax）`);
      audioBuffers.push(await ttsToBuffer(finalTexts[i], voiceId));
    }

    const merged = Buffer.concat(audioBuffers);
    const audioUrl = await uploadToGCS(taskId, merged);

    await taskSnap.ref.update({
      status: 'done',
      podcastPhase: 'audio_done',
      audioUrl,
      completedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ audioUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await taskSnap.ref.update({ status: 'failed', error: msg }).catch(() => {});
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
