/**
 * Cloud Tasks 派工 —— 把文件 job 丟給 Cloud Run doc worker。
 *
 * 走 REST API 而非 @google-cloud/tasks SDK，避免 protos.json 在 Vercel 找不到的問題。
 * 未設定 Cloud Tasks env 時 no-op（Phase 7 前聊天仍可跑，job 留 pending）。
 */
import { GoogleAuth } from 'google-auth-library';

let auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (auth) return auth;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  auth = saJson
    ? new GoogleAuth({ credentials: JSON.parse(saJson), scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return auth;
}

export async function enqueueDocumentJob(jobId: string): Promise<void> {
  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.CLOUD_TASKS_LOCATION || 'us-central1';
  const queue = process.env.DOC_TASKS_QUEUE;
  const workerUrl = process.env.DOC_WORKER_URL;
  const invokerSa = process.env.DOC_WORKER_INVOKER_SA;

  if (!project || !queue || !workerUrl) {
    console.warn('[enqueue] Cloud Tasks 未設定，job', jobId, '留 pending');
    return;
  }

  const token = await getAuth().getAccessToken();
  const accessToken = typeof token === 'string' ? token : (token as unknown as { token?: string })?.token || '';

  const url = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${location}/queues/${queue}/tasks`;

  const body = Buffer.from(JSON.stringify({ jobId })).toString('base64');
  const task: Record<string, unknown> = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${workerUrl.replace(/\/$/, '')}/process`,
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(invokerSa ? { oidcToken: { serviceAccountEmail: invokerSa, audience: workerUrl } } : {}),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloud Tasks createTask failed (${res.status}): ${err.slice(0, 300)}`);
  }
}
