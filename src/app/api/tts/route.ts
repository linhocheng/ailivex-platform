/**
 * POST /api/tts
 * MiniMax T2A v2 → MP3 stream
 * Body: { text: string; voiceId: string }
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function sseToMp3Stream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
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
              if (audioHex && parsed?.data?.status === 1) controller.enqueue(hexToBytes(audioHex));
            } catch { /* skip bad chunk */ }
          }
        }
      } catch (e) {
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });
}

interface VoiceSettings { speed?: number; pitch?: number; vol?: number; emotion?: string; }

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as {
    text?: string; voiceId?: string; settings?: VoiceSettings;
  } | null;
  const text = body?.text?.trim();
  const voiceId = body?.voiceId?.trim();

  if (!text || !voiceId) return NextResponse.json({ error: 'text 與 voiceId 必填' }, { status: 400 });

  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) return NextResponse.json({ error: 'MiniMax 未設定' }, { status: 500 });

  const s = body?.settings || {};
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'speech-02-turbo',
      text,
      stream: true,
      stream_options: { exclude_aggregated_audio: true },
      language_boost: null,
      voice_setting: {
        voice_id: voiceId,
        speed: s.speed ?? 1.0,
        vol: s.vol ?? 1.0,
        pitch: s.pitch ?? 0,
        emotion: s.emotion ?? 'neutral',
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });

  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => '');
    return NextResponse.json({ error: `MiniMax ${res.status}: ${err.slice(0, 200)}` }, { status: 500 });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('event-stream')) {
    const text2 = await res.text().catch(() => '');
    return NextResponse.json({ error: `非 SSE: ${text2.slice(0, 200)}` }, { status: 500 });
  }

  return new NextResponse(sseToMp3Stream(res.body), {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    },
  });
}
