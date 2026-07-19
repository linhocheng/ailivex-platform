/**
 * LiveKit token 簽發 —— 即時語音通話。
 *
 * ailiveX 隔離：agentName='ailivex-realtime'、room/conv 前綴 'ailivex-'。
 * 與 ailive 共用 LiveKit project 時靠 agent_name + RoomAgentDispatch 區隔，不靠 prompt。
 * 後端把關：未被指派該角色 → 403（不只靠大廳隱藏）。
 */
import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { RoomConfiguration, RoomAgentDispatch } from '@livekit/protocol';
import { buildRoomEgress, recordingFilepath, livekitHttpUrl } from '@/lib/recording';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL, agentNameForVersion, VOICE_VERSIONS, DEFAULT_VOICE_VERSION, GPT_VOICE_LINE, TRAINER_VOICE_LINE, type CharacterDoc, type AccessDoc } from '@/lib/collections';
import { checkVoiceQuota, QuotaExceededError } from '@/lib/quota';
import { touchLastCallAt } from '@/lib/voice-power';
import { openVoiceSession } from '@/lib/ops-event';
import { maybeScaleUp } from '@/lib/voice-capacity';

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

  const body = await req.json().catch(() => null) as { characterId?: string; line?: string } | null;
  const characterId = body?.characterId?.trim();
  if (!characterId) return NextResponse.json({ error: 'characterId 必填' }, { status: 400 });
  const wantGptLine = body?.line === GPT_VOICE_LINE.id;  // GPT Voice 線（獨立按鈕，已退役）
  const wantTrainerLine = body?.line === TRAINER_VOICE_LINE.id;  // 訓練線（共創按鈕，admin 限定）

  const db = getFirestore();
  const userId = user.uid;

  // 電源咽喉閘：後台語音開關關閉時一律拒發 token（admin 也擋，避免測試假象）。
  // 這裡是撥號唯一入口，擋住這裡＝不可能派工，與雲端實例殘尾無關。
  const powerSnap = await db.collection('config').doc('voicePower').get();
  if (powerSnap.exists && (powerSnap.data() as { on?: boolean }).on === false) {
    return NextResponse.json({ error: 'voice_power_off', message: '語音引擎已關閉' }, { status: 403 });
  }

  // 版本決策：前台只有一個入口，一律走 DEFAULT_VOICE_VERSION（現值見 collections.ts，別在這裡寫死版本號）。
  // 一般用戶需有 access doc；admin 免 access doc 直接進。
  let voiceVersion: string | undefined;
  let gptVoiceEnabled = false;
  let voiceSecondsRemaining: number | null = null;  // null = 不限
  if (user.role !== 'admin') {
    const accessSnap = await db.collection(COL.access).doc(`${userId}_${characterId}`).get();
    if (!accessSnap.exists) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    voiceVersion = (accessSnap.data() as AccessDoc).voiceVersion;
    gptVoiceEnabled = !!(accessSnap.data() as AccessDoc).gptVoiceEnabled;

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
    gptVoiceEnabled = true;  // admin 恆可測 GPT 線
  }
  // GPT Voice 線：明確要求 + 有權限才分流；沒權限回 403 不靜默降級（避免「以為在測 GPT 其實打到 v18」的假象）
  // 退役閘（2026-07-16 判負）：服務已降 0＝聾，派過去是死通話——防禦釘在派工咽喉，不只藏按鈕
  if (wantGptLine && GPT_VOICE_LINE.retired) {
    return NextResponse.json({ error: 'gpt_voice_retired', message: 'GPT Voice 線已退役' }, { status: 403 });
  }
  if (wantGptLine && !gptVoiceEnabled) {
    return NextResponse.json({ error: 'gpt_voice_not_enabled', message: 'GPT Voice 未開通' }, { status: 403 });
  }
  let agentName = wantGptLine ? GPT_VOICE_LINE.agentName : agentNameForVersion(voiceVersion); // 缺省 = DEFAULT_VOICE_VERSION

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  // 訓練線：admin 限定（所有角色通用，2026-07-19 起 per-character 旗標退役），沒過回 403 不靜默降級
  if (wantTrainerLine) {
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'trainer_line_admin_only', message: '訓練線僅限管理員' }, { status: 403 });
    }
    agentName = TRAINER_VOICE_LINE.agentName;
  }

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

  // 對話錄音（角色級開關）：顯式建房掛 auto egress —— 房間一有人錄音就開、
  // 人走光自動停；agent/容量/未開錄音的角色完全不受影響。
  // fail-closed：訪談用途下沒錄到的通話等於白打，建房失敗就不發 token，當場報錯。
  // ⚠️ 派工必須跟著建房走：token 上的 RoomConfiguration 只在「join 時自動建房」才生效，
  //    房間既存時會被忽略——預建房不帶 agents = agent 永遠不進房（2026-07-13 實測踩雷）。
  if (char.recordingEnabled) {
    const egress = buildRoomEgress(characterId, roomName);
    if (!egress) {
      return NextResponse.json({ error: 'recording_unconfigured', message: '錄音未設定（EGRESS_GCS_CREDENTIALS）' }, { status: 503 });
    }
    try {
      const rsc = new RoomServiceClient(livekitHttpUrl(), apiKey, apiSecret);
      await rsc.createRoom({
        name: roomName, egress,
        agents: [new RoomAgentDispatch({ agentName, metadata })],
      });
      await db.collection(COL.recordings).doc(roomName).set({
        roomName, characterId, characterName: char.name || '', userId,
        filepath: recordingFilepath(characterId, roomName),
        status: 'recording', createdAt: new Date(),
      });
    } catch (e) {
      console.error('[livekit/token] 錄音建房失敗:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'recording_setup_failed', message: '錄音啟動失敗，本通未建立' }, { status: 503 });
    }
  }

  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: user.name, metadata });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName, metadata })],
  });

  const token = await at.toJwt();
  touchLastCallAt(); // auto-off cron 以此判定「還有人在用」
  // 實際派工版本（畫面左上角顯示真值——頁面標籤是死的，派工才是真相）
  const resolvedVersion = wantGptLine
    ? GPT_VOICE_LINE.id
    : (VOICE_VERSIONS.find(v => v.agentName === agentName)?.id ?? DEFAULT_VOICE_VERSION);
  openVoiceSession(roomName, userId, characterId, resolvedVersion); // 監控 session 開盤（fire-and-forget）
  // 水位調節器升檔檢查：發 token=有人要打電話（領先指標），水位 ≥70% 先暖下一台。
  // after() 保證回應後執行完（Vercel void-write 凍結雷），不拖慢 token 發放。
  after(() => maybeScaleUp());

  return NextResponse.json({
    token, url, roomName, identity: userId,
    characterName: char.name || '',
    avatarUrl: char.avatarUrl || '',
    webSearch: (char.capabilities || []).includes('web_search'),
    voiceVersion: resolvedVersion,
  });
}
