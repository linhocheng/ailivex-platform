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
import { COL, agentNameForVersion, type CharacterDoc, type AccessDoc } from '@/lib/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: 'LIVEKIT_* env 未設定' }, { status: 500 });
  }

  const body = await req.json().catch(() => null) as { characterId?: string; v2?: boolean; v3?: boolean; v4?: boolean; v5?: boolean; v6?: boolean; v8?: boolean; v9?: boolean; v10?: boolean; v11?: boolean; v12?: boolean; v13?: boolean } | null;
  const characterId = body?.characterId?.trim();
  if (!characterId) return NextResponse.json({ error: 'characterId 必填' }, { status: 400 });

  const db = getFirestore();
  const userId = user.uid;

  // 版本決策：用戶端看不到版本，派哪版由後台指派決定（缺省走 DEFAULT_VOICE_VERSION）。
  // admin 例外：帶 vN flag 直接走該版（保留逐版測試能力，admin 無 access doc）。
  let voiceVersion: string | undefined;
  if (user.role === 'admin') {
    voiceVersion = body?.v13 ? 'v13' : body?.v12 ? 'v12' : body?.v11 ? 'v11' : body?.v10 ? 'v10' : body?.v9 ? 'v9' : body?.v8 ? 'v8' : body?.v6 ? 'v6' : body?.v5 ? 'v5' : body?.v4 ? 'v4' : body?.v3 ? 'v3' : body?.v2 ? 'v2' : undefined;
  } else {
    const accessSnap = await db.collection(COL.access).doc(`${userId}_${characterId}`).get();
    if (!accessSnap.exists) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    voiceVersion = (accessSnap.data() as AccessDoc).voiceVersion;
  }
  const agentName = agentNameForVersion(voiceVersion);

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  const ts = Date.now();
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
    webSearch: (char.capabilities || []).includes('web_search'),
  });
}
