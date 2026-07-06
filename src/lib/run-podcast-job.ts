/**
 * Cloud Run Jobs 派工（podcast 長生成正路）
 *
 * 為什麼：202+背景的 worker service 在 min-instances=0 下，閒置回收會砍掉
 * 跑到一半的長生成。Jobs 跑到完成才結束、按執行時間計費、零常駐。
 *
 * 啟用方式：Vercel 設 env PODCAST_JOB_NAME=ailivex-podcast-job。
 * 未設時呼叫端 fallback 舊的 worker URL 路徑（回退開關，穩定後可拆）。
 *
 * 鑑權：Vercel 上用 FIREBASE_SERVICE_ACCOUNT_JSON（同 embeddings/voice-power 模式）。
 */
import { GoogleAuth } from 'google-auth-library';

const JOB_REGION = 'asia-east1';
const PODCAST_JOB_NAME = (process.env.PODCAST_JOB_NAME ?? '').trim();

export type PodcastJobAction = 'script' | 'audio';

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

export function podcastJobEnabled(): boolean {
  return PODCAST_JOB_NAME.length > 0;
}

/** 觸發一次 job 執行；job 端參數一律讀 Firestore task doc（派工前先寫齊）。 */
export async function runPodcastJob(taskId: string, action: PodcastJobAction): Promise<void> {
  const t = await getAuth().getAccessToken();
  const token = typeof t === 'string' ? t : (t as unknown as { token?: string })?.token || '';
  const url = `https://run.googleapis.com/v2/projects/${getProjectId()}/locations/${JOB_REGION}/jobs/${PODCAST_JOB_NAME}:run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{
          env: [
            { name: 'TASK_ID', value: taskId },
            { name: 'JOB_ACTION', value: action },
          ],
        }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`jobs.run ${res.status}: ${err.slice(0, 160)}`);
  }
}
