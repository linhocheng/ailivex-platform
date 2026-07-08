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
import { checkVoiceQuota, QuotaExceededError } from '@/lib/quota';
import { touchLastCallAt } from '@/lib/voice-power';

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

  const body = await req.json().catch(() => null) as { characterId?: string } | null;
  const characterId = body?.characterId?.trim();
  if (!characterId) return NextResponse.json({ error: 'characterId 必填' }, { status: 400 });

  const db = getFirestore();
  const userId = user.uid;

  // 電源咽喉閘：後台語音開關關閉時一律拒發 token（admin 也擋，避免測試假象）。
  // 這裡是撥號唯一入口，擋住這裡＝不可能派工，與雲端實例殘尾無關。
  const powerSnap = await db.collection('config').doc('voicePower').get();
  if (powerSnap.exists && (powerSnap.data() as { on?: boolean }).on === false) {
    return NextResponse.json({ error: 'voice_power_off', message: '語音引擎已關閉' }, { status: 403 });
  }

  // 版本決策：前台只有一個入口，一律走 DEFAULT_VOICE_VERSION（v14）。
  // 一般用戶需有 access doc；admin 免 access doc 直接進。
  let voiceVersion: string | undefined;
  let voiceSecondsRemaining: number | null = null;  // null = 不限
  if (user.role !== 'admin') {
    const accessSnap = await db.collection(COL.access).doc(`${userId}_${characterId}`).get();
    if (!accessSnap.exists) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    voiceVersion = (accessSnap.data() as AccessDoc).voiceVersion;

    // 用量閘：語音總時數用完 → 不發 token（admin 免管制）
    try {
      const q = await checkVoiceQuota(db, userId);
      voiceSecondsRemaining = q.voiceSecondsRemaining;
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return NextResponse.json({ error: 'voice_quota_exhausted', message: '語音時數已用完' }, { status: 403 });
      }
      throw e;
    }
  }
  if (user.role === 'admin') {
    // admin 免 access doc；但若有（canary 版本指派），voiceVersion 照讀——否則 admin 永遠測不到新版本
    const accessSnap = await db.collection(COL.access).doc(`${userId}_${characterId}`).get();
    if (accessSnap.exists) voiceVersion = (accessSnap.data() as AccessDoc).voiceVersion;
  }
  const agentName = agentNameForVersion(voiceVersion); // 缺省 = DEFAULT_VOICE_VERSION

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
    // 用量管制：agent 進房讀這個做通話中計量與到點斷線（null = 不限）
    voiceSecondsRemaining,
  });

  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: user.name, metadata });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName, metadata })],
  });

  const token = await at.toJwt();
  touchLastCallAt(); // auto-off cron 以此判定「還有人在用」
  return NextResponse.json({
    token, url, roomName, identity: userId,
    characterName: char.name || '',
    avatarUrl: char.avatarUrl || '',
    webSearch: (char.capabilities || []).includes('web_search'),
  });
}
