/**
 * 語音引擎電源 — 共用邏輯（admin 開關 route 與 auto-off cron 共用同一份）
 *
 * 兩層開關：
 *  - 功能層：Firestore config/voicePower 旗標，token route 讀它拒發（秒級、零殘尾）
 *  - 費用層：Cloud Run min-instances（每次切換會產生一顆驗證實例，活最長 15 分鐘）
 */
import { GoogleAuth } from 'google-auth-library';
import { getFirestore } from '@/lib/firebase-admin';
import { DEFAULT_VOICE_VERSION } from '@/lib/collections';

// canary 版本也掛在同一個電源開關＋自動關機傘下（天條：常駐必配開關＋自動關機）。
// canary 收案（升 DEFAULT 或退役）時從這裡拔掉。
const CANARY_VOICE_VERSIONS: string[] = [];  // v17 已是 DEFAULT（開關本來就管它）；目前無 canary

const REGION = 'asia-east1';
export const AUTO_OFF_HOURS_DEFAULT = 3;

export interface VoicePowerFlag {
  on: boolean;
  onSince?: string;     // 最近一次開啟時間（ISO）
  lastCallAt?: string;  // 最近一次成功發 token（ISO）
  autoOffHours?: number;
  updatedAt?: string;
}

let authClient: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (authClient) return authClient;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  authClient = saJson
    ? new GoogleAuth({ credentials: JSON.parse(saJson), scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return authClient;
}

function getProjectId(): string {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson) return JSON.parse(saJson).project_id;
  return process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '';
}

export function cloudRunServiceUrl(version: string = DEFAULT_VOICE_VERSION): string {
  return `https://run.googleapis.com/v2/projects/${getProjectId()}/locations/${REGION}/services/ailivex-realtime-agent-${version}`;
}

/** 電源開關管到的所有版本（預設＋canary），開/關一起動 */
export function poweredVoiceVersions(): string[] {
  return [DEFAULT_VOICE_VERSION, ...CANARY_VOICE_VERSIONS.filter(v => v !== DEFAULT_VOICE_VERSION)];
}

export async function cloudRunAccessToken(): Promise<string> {
  const t = await getAuth().getAccessToken();
  return typeof t === 'string' ? t : (t as unknown as { token?: string })?.token || '';
}

export async function readVoicePowerFlag(): Promise<VoicePowerFlag> {
  const snap = await getFirestore().collection('config').doc('voicePower').get();
  if (!snap.exists) return { on: true }; // 缺 doc 視為開（向後相容）
  const d = snap.data() as VoicePowerFlag;
  return { ...d, on: d.on !== false };
}

/** 寫功能旗標＋調 Cloud Run 常駐。旗標先寫（咽喉閘），Cloud Run 失敗會 throw。 */
export async function setVoicePower(on: boolean, source: 'admin' | 'auto-off'): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { on, updatedAt: now, updatedBy: source };
  if (on) patch.onSince = now;
  await getFirestore().collection('config').doc('voicePower').set(patch, { merge: true });

  const token = await cloudRunAccessToken();
  const failures: string[] = [];
  for (const version of poweredVoiceVersions()) {
    const res = await fetch(`${cloudRunServiceUrl(version)}?updateMask=template.scaling.minInstanceCount`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: { scaling: { minInstanceCount: on ? 1 : 0 } } }),
    });
    if (!res.ok) {
      const err = await res.text();
      failures.push(`${version}(${res.status}): ${err.slice(0, 120)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Cloud Run 切換失敗: ${failures.join(' | ')}`);
  }
}

/** token route 成功發 token 時戳一下，auto-off 以此判定「有沒有人在用」。 */
export function touchLastCallAt(): void {
  getFirestore().collection('config').doc('voicePower')
    .set({ lastCallAt: new Date().toISOString() }, { merge: true })
    .catch(() => {}); // 戳不到不影響通話
}
