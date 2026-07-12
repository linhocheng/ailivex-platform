/**
 * Podcast 音檔生成（從 Vercel generate-audio 搬來——300s 上限撞牆的根治）
 * 流程：角色自貼情緒標記（bridge Sonnet）→ 逐行 MiniMax TTS（帶各角色 voiceSettings）
 *      → 合併 MP3 → GCS → audioUrl 寫回 task
 */
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { normalizeTTSText } from './tts-normalize.js';

export interface PodcastLine { speaker: string; characterId: string; text: string; }

interface VoiceSettings { speed?: number; pitch?: number; vol?: number; emotion?: string; }

const VALID_INTERJECTION = new Set(['emm', 'breath', 'sighs', 'chuckle', 'inhale', 'exhale', 'gasps']);

function sanitizeTags(text: string): string {
  return text
    .replace(/\\n/g, ' ') // 字面 \n 保底（腳本收斂點已修，消費端再守一次）
    .replace(/^[ \t]*[-—─]{2,}[ \t]*$/gm, '<#1.0#>') // 台詞裡的節拍分隔線（---）→ 停頓，不能唸出來
    // 全形括號舞台指示不能進 TTS：停頓家族 → MiniMax 停頓標記；其餘（轉向台下、沉默幾秒等）→ 拿掉不唸
    .replace(/（[^）]{0,20}(停頓|停一下|停很久|沉默|停)[^）]{0,20}）/g, '<#1.0#>')
    .replace(/（[^）]{0,30}）/g, '')
    .replace(/\(([^)]+)\)/g, (m, inner) =>
      VALID_INTERJECTION.has(inner.trim()) ? m : '')
    .replace(/<([^>]+)>/g, (m, inner) =>
      /^#[\d.]+#$/.test(inner.trim()) ? m : '');
}

async function tagLinesForCharacter(
  bridgeEndpoint: string,
  bridgeSecret: string,
  character: { name: string; soul: string; soulCore?: string },
  lines: string[],
): Promise<string[]> {
  if (lines.length === 0) return [];
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

  const res = await fetch(bridgeEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': bridgeSecret },
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
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bridge tagging ${res.status}: ${errText.slice(0, 100)}`);
  }

  const data = await res.json() as { content?: Array<{ text: string }> };
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

async function ttsToBuffer(text: string, voiceId: string, vs?: VoiceSettings): Promise<Buffer> {
  const apiKey = (process.env.MINIMAX_API_KEY ?? '').trim();
  const groupId = (process.env.MINIMAX_GROUP_ID ?? '').trim();
  if (!apiKey || !groupId) throw new Error('MiniMax 未設定');
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
      // 帶角色 voiceSettings；speed 預設 1.05 是 podcast 節奏基準，角色有設定則以角色為準
      voice_setting: {
        voice_id: voiceId,
        speed: vs?.speed ?? 1.05,
        vol: vs?.vol ?? 1.0,
        pitch: vs?.pitch ?? 0,
        ...(vs?.emotion ? { emotion: vs.emotion } : {}),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) throw new Error(`MiniMax TTS ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: Uint8Array[] = [];
  let buffer = '';

  for (;;) {
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
        const parsed = JSON.parse(jsonText) as { data?: { audio?: string; status?: number } };
        const audioHex = parsed?.data?.audio;
        if (audioHex && parsed?.data?.status === 1) chunks.push(hexToBytes(audioHex));
      } catch { /* skip */ }
    }
  }

  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

async function uploadToGCS(taskId: string, buffer: Buffer): Promise<string> {
  const bucket = getStorage().bucket();
  const file = bucket.file(`podcast/${taskId}.mp3`);
  await file.save(buffer, { metadata: { contentType: 'audio/mpeg' }, resumable: false });
  // ?v= 讓重生成後 URL 改變，繞過瀏覽器/CDN 對舊音檔的快取
  return `https://storage.googleapis.com/${bucket.name}/podcast/${taskId}.mp3?v=${Date.now()}`;
}

/** 主流程：標記 → 逐行 TTS → 合併 → 上傳 → 寫回。呼叫端負責 status 前置與錯誤處理。 */
export async function generateAudio(
  taskId: string,
  script: PodcastLine[],
  bridgeEndpoint: string,
  bridgeSecret: string,
): Promise<string> {
  const db = getFirestore();
  const characterIds = [...new Set(script.map(l => l.characterId))];
  const charSnaps = await Promise.all(characterIds.map(id => db.collection('characters').doc(id).get()));

  const charMap: Record<string, { name: string; soul: string; soulCore?: string; voiceId: string; voiceSettings?: VoiceSettings }> = {};
  for (const snap of charSnaps) {
    if (!snap.exists) continue;
    const c = snap.data() as { name: string; soul: string; soulCore?: string; voiceIdMinimax?: string; voiceSettings?: VoiceSettings };
    charMap[snap.id] = { name: c.name, soul: c.soul, soulCore: c.soulCore,
      voiceId: c.voiceIdMinimax ?? '', voiceSettings: c.voiceSettings };
  }

  // 多段落台詞壓平成單行（換行＝節奏 → 停頓標記）。
  // 不壓平的話，標記往返的行編號正則只抓得到第一行——多段落的其餘段落會無聲蒸發。
  // 順序：先把分隔線行（---）轉停頓（壓平後行錨點就沒了），再壓換行。
  const flatten = (t: string) => t
    .replace(/^[ \t]*[-—─]{2,}[ \t]*$/gm, '<#1.0#>')
    .replace(/\s*\n+\s*/g, ' <#0.5#> ')
    .replace(/(?:<#[\d.]+#>\s*){2,}/g, '<#1.0#> ') // 相鄰停頓去重（分隔線＋換行會疊出兩顆）
    .trim();

  // 角色自貼情緒標記（每角色只看自己的台詞）
  const charLineGroups = new Map<string, { indices: number[]; texts: string[] }>();
  for (let i = 0; i < script.length; i++) {
    const { characterId } = script[i];
    if (!charLineGroups.has(characterId)) charLineGroups.set(characterId, { indices: [], texts: [] });
    const group = charLineGroups.get(characterId)!;
    group.indices.push(i);
    group.texts.push(flatten(script[i].text));
  }

  const taggedTexts: string[] = script.map(l => flatten(l.text));
  for (const [charId, { indices, texts }] of charLineGroups) {
    const char = charMap[charId];
    if (!char) continue;
    const tagged = await tagLinesForCharacter(bridgeEndpoint, bridgeSecret, char, texts);
    console.log(`[podcast-audio] 標記 ${char.name} (${indices.length} 行)`);
    indices.forEach((scriptIdx, groupIdx) => {
      taggedTexts[scriptIdx] = tagged[groupIdx] ?? script[scriptIdx].text;
    });
  }

  // 換人說話前插入停頓
  const finalTexts = taggedTexts.map((text, i) => {
    const sameSpeaker = i > 0 && script[i].characterId === script[i - 1].characterId;
    const pause = i === 0 ? '' : sameSpeaker ? '<#0.3#>' : '<#0.5#>';
    return `${pause}${text}`;
  });

  // 逐行 TTS（帶各角色自己的 voiceSettings——每個角色音量/語速可以不一樣）
  const audioBuffers: Buffer[] = [];
  for (let i = 0; i < script.length; i++) {
    const char = charMap[script[i].characterId];
    if (!char?.voiceId) throw new Error(`角色 ${script[i].speaker} 沒有設定聲音（voiceIdMinimax）`);
    audioBuffers.push(await ttsToBuffer(finalTexts[i], char.voiceId, char.voiceSettings));
    if ((i + 1) % 5 === 0) console.log(`[podcast-audio] TTS ${i + 1}/${script.length}`);
  }

  const merged = Buffer.concat(audioBuffers);
  const audioUrl = await uploadToGCS(taskId, merged);

  await db.collection('tasks').doc(taskId).update({
    status: 'done',
    podcastPhase: 'audio_done',
    audioUrl,
    completedAt: FieldValue.serverTimestamp(),
  });

  return audioUrl;
}
