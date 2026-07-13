/**
 * 對話錄音（LiveKit Egress）—— 共用邏輯。
 *
 * 路線：角色 recordingEnabled → token route 顯式 CreateRoom 掛 auto egress
 * （混流 audio-only MP4 直落 GCS），房間人走光錄音自動停，agent 熱路徑零改動。
 *
 * ⚠️ 計費雷（勿動）：audio-only 絕不能設 layout / customBaseUrl —— 一設就被
 * 路由進視訊轉碼管線，$0.02/分 vs $0.005/分（LiveKit 官方文件明載）。
 *
 * 收帳雙保險：egress_ended webhook 即時收；admin 列表 reconcile 兜底
 * （webhook 未設定或漏接時，用 listEgress 對帳）。
 */
import type { Firestore } from 'firebase-admin/firestore';
import { EgressClient, EgressStatus } from 'livekit-server-sdk';
import {
  RoomEgress, RoomCompositeEgressRequest, EncodedFileOutput, EncodedFileType, GCPUpload,
} from '@livekit/protocol';
import { COL, type RecordingDoc } from './collections';

/** LIVEKIT_URL 是 wss://，REST client 要 https:// */
export function livekitHttpUrl(): string {
  return (process.env.LIVEKIT_URL || '').replace(/^ws/, 'http');
}

export function recordingFilepath(characterId: string, roomName: string): string {
  return `recordings/${characterId}/${roomName}.mp4`;
}

/** 建房用的 auto egress 設定；env 未備齊回 null（呼叫端 fail-closed） */
export function buildRoomEgress(characterId: string, roomName: string): RoomEgress | null {
  const credentials = process.env.EGRESS_GCS_CREDENTIALS;
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!credentials || !bucket) return null;
  return new RoomEgress({
    room: new RoomCompositeEgressRequest({
      audioOnly: true,
      fileOutputs: [new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: recordingFilepath(characterId, roomName),
        output: { case: 'gcp', value: new GCPUpload({ credentials, bucket }) },
      })],
    }),
  });
}

/** EgressInfo → recordings doc 的收帳欄位（duration/size 是 bigint 奈秒/位元組） */
export function egressResultFields(info: {
  egressId: string; status: EgressStatus;
  fileResults?: { duration?: bigint; size?: bigint }[];
}): Partial<RecordingDoc> {
  const file = info.fileResults?.[0];
  const done = info.status === EgressStatus.EGRESS_COMPLETE;
  return {
    egressId: info.egressId,
    status: done ? 'done' : 'failed',
    durationSec: file?.duration ? Math.round(Number(file.duration) / 1e9) : 0,
    sizeBytes: file?.size ? Number(file.size) : 0,
    endedAt: new Date(),
  };
}

const ACTIVE_STATUSES = new Set([EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE, EgressStatus.EGRESS_ENDING]);

/**
 * 對帳兜底：卡在 recording 超過 10 分鐘的 doc，向 LiveKit 查 egress 真實狀態回填。
 * webhook 正常時這裡幾乎無事可做；確定性程式，不經 LLM。
 */
export async function reconcileRecordings(db: Firestore): Promise<void> {
  const stale = await db.collection(COL.recordings)
    .where('status', '==', 'recording')
    .limit(20).get();
  if (stale.empty) return;

  const ec = new EgressClient(livekitHttpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  const cutoff = Date.now() - 10 * 60 * 1000;

  for (const doc of stale.docs) {
    const d = doc.data() as RecordingDoc;
    const createdMs = d.createdAt instanceof Date ? d.createdAt.getTime() : d.createdAt.toMillis();
    if (createdMs > cutoff) continue; // 可能還在通話中，不動
    try {
      const list = await ec.listEgress({ roomName: d.roomName });
      const info = list[0];
      if (!info) {
        // 建了房但 egress 從未啟動（例如房間沒人進過）→ 收失敗帳
        await doc.ref.update({ status: 'failed', endedAt: new Date() });
      } else if (!ACTIVE_STATUSES.has(info.status)) {
        await doc.ref.update(egressResultFields(info) as Record<string, unknown>);
      }
    } catch (e) {
      console.warn(`[recording] reconcile ${d.roomName} 失敗:`, e instanceof Error ? e.message : e);
    }
  }
}
