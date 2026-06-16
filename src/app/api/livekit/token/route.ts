/**
 * LiveKit token 簽發 —— 即時語音通話。
 *
 * ailiveX 隔離：agentName='ailivex-realtime'、room/conv 前綴 'ailivex-'。
 * 與 ailive 共用 LiveKit project 時靠 agent_name + RoomAgentDispatch 區隔，不靠 prompt。
 * 後端把關：未被指派該角色 → 403（不只靠大廳隱藏）。
 */
import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { RoomConfiguration, RoomAgentDispatch } from '@livekit/protocol';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { hasAccess } from '@/lib/access';
import { COL, type CharacterDoc } from '@/lib/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AGENT_NAME = 'ailivex-realtime';
const AGENT_NAME_V2 = 'ailivex-realtime-v2';  // 即時語音 2.0（主動插話實驗版，獨立服務）
const AGENT_NAME_V3 = 'ailivex-realtime-v3';  // 即時語音 3.0（主動發話 pipe-test / 群聊，獨立服務）
const AGENT_NAME_V4 = 'ailivex-realtime-v4';  // 即時語音 4.0（單機群聊：Soniox diarization 多人辨識，獨立服務）
const AGENT_NAME_V5 = 'ailivex-realtime-v5';  // 即時語音 5.0（v4 + 發話對象偵測：把棒子交給第三方時 AI 靜默讓位）
const AGENT_NAME_V6 = 'ailivex-realtime-v6';  // 即時語音 6.0（v5 + 背景思考層 + 主動搶話：判斷腦 Haiku／開口腦 Sonnet）
const AGENT_NAME_V8 = 'ailivex-realtime-v8';  // 即時語音 8.0（v6 + 發言權控制：被點名抓麥克風／交棒第三方就閉嘴）
const AGENT_NAME_V9 = 'ailivex-realtime-v9';  // 即時語音 9.0（v8 + LLM floor-gate：多人情境發言權判斷改 Haiku）
const AGENT_NAME_V10 = 'ailivex-realtime-v10'; // 即時語音 10.0（v9 + 多人房：回音過濾 / 講者身份名冊 / 3a 收斂）

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: 'LIVEKIT_* env 未設定' }, { status: 500 });
  }

  const body = await req.json().catch(() => null) as { characterId?: string; v2?: boolean; v3?: boolean; v4?: boolean; v5?: boolean; v6?: boolean; v8?: boolean; v9?: boolean; v10?: boolean } | null;
  const characterId = body?.characterId?.trim();
  if (!characterId) return NextResponse.json({ error: 'characterId 必填' }, { status: 400 });
  const agentName = body?.v10 ? AGENT_NAME_V10 : body?.v9 ? AGENT_NAME_V9 : body?.v8 ? AGENT_NAME_V8 : body?.v6 ? AGENT_NAME_V6 : body?.v5 ? AGENT_NAME_V5 : body?.v4 ? AGENT_NAME_V4 : body?.v3 ? AGENT_NAME_V3 : body?.v2 ? AGENT_NAME_V2 : AGENT_NAME;

  const db = getFirestore();
  if (user.role !== 'admin' && !(await hasAccess(db, user.uid, characterId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  const ts = Date.now();
  const userId = user.uid;
  const convId = `ailivex-voice-${characterId}-${userId}`;
  const roomName = `ailivex-${characterId}-${userId}-${ts}`;

  const metadata = JSON.stringify({
    characterId,
    userId,
    convId,
    characterName: char.name || '',
    voiceId: char.voiceIdMinimax || '',
  });

  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: user.name, metadata });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName, metadata })],
  });

  const token = await at.toJwt();
  return NextResponse.json({
    token, url, roomName, identity: userId,
    characterName: char.name || '',
    avatarUrl: char.avatarUrl || '',
  });
}
