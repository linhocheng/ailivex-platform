/**
 * Task Dispatcher — 角色大腦呼叫工廠的唯一入口。
 *
 * 角色說「我想做 X」→ dispatchTask() → Firestore tasks doc（pending）
 * → 路由到對應 worker API → worker 完成後更新 tasks doc（done）
 * → 下次對話 firestore_loader 注入通知給角色。
 *
 * 加新工廠：在 WORKER_ROUTES 加一行，角色 code 完全不動。
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '@/lib/firebase-admin';
import { COL, type TaskCapability, type TaskDoc } from '@/lib/collections';
import { cleanSecret, cleanUrl } from '@/lib/clean-env';

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);

// media-worker 完成後回呼平台的 callback URL（穩定 production 域名）
function callbackUrl(): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return `${cleanUrl(base)}/api/tasks/callback`;
}

// ── 路由表：capability → worker 呼叫函數 ──────────────────────────────
const WORKER_ROUTES: Record<TaskCapability, (taskId: string, params: Record<string, unknown>) => Promise<void>> = {
  image_generation: enqueueImageJob,
  audio_generation: enqueueAudioJob,
  writing: enqueueWritingJob,
  web_search: enqueueWebSearchJob,
};

export interface DispatchResult {
  taskId: string;
  message: string;   // 角色可直接說給用戶聽的一句話
}

export async function dispatchTask(
  userId: string,
  characterId: string,
  type: TaskCapability,
  intent: string,
  params: Record<string, unknown> = {}
): Promise<DispatchResult> {
  const db = getFirestore();
  const ref = db.collection(COL.tasks).doc();
  const taskId = ref.id;

  const doc: Omit<TaskDoc, 'createdAt'> = {
    userId, characterId, type, intent, params,
    status: 'pending',
    notified: false,
  };

  await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp() });

  // 非同步路由，不等結果（fire-and-forget）
  const route = WORKER_ROUTES[type];
  if (route) {
    route(taskId, params).catch(err => {
      console.error(`[task-dispatcher] worker error taskId=${taskId}:`, err instanceof Error ? err.message : String(err));
      ref.update({ status: 'failed', error: String(err), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
  }

  return {
    taskId,
    message: DISPATCH_MESSAGES[type] ?? '任務已派出，完成後我會告訴你。',
  };
}

const DISPATCH_MESSAGES: Record<TaskCapability, string> = {
  image_generation: '我已派出製圖任務，完成後你可以在圖庫查看。',
  audio_generation: '我已派出音檔生成任務，完成後你可以在媒體庫查看。',
  writing: '我已開始寫這份文件，完成後你可以在文件區查看。',
  web_search: '我已派出搜尋任務，完成後我會告訴你結果。',
};

// ── Worker 呼叫實作 ──────────────────────────────────────────────────

async function enqueueImageJob(taskId: string, params: Record<string, unknown>): Promise<void> {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) throw new Error('MEDIA_WORKER_URL or MEDIA_WORKER_KEY_AILIVEX not set');

  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MEDIA_WORKER_KEY,
    },
    body: JSON.stringify({
      mediaType: 'image',
      idempotencyKey: taskId,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: {
        prompt: (params.prompt as string) ?? (params.intent as string) ?? '',
        size: (params.size as string) ?? '1024x1024',
        outputFormat: 'png',
      },
      metadata: { taskId },
    }),
  });

  if (!resp.ok) throw new Error(`media-worker ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { jobId: string };
  await getFirestore().collection(COL.tasks).doc(taskId).update({
    status: 'running',
    resultRef: `mw_jobs/${data.jobId}`,
  });
}

async function enqueueAudioJob(taskId: string, params: Record<string, unknown>): Promise<void> {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_KEY) throw new Error('MEDIA_WORKER_URL or MEDIA_WORKER_KEY_AILIVEX not set');

  const resp = await fetch(`${MEDIA_WORKER_URL}/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MEDIA_WORKER_KEY,
    },
    body: JSON.stringify({
      mediaType: 'audio',
      idempotencyKey: taskId,
      webhookUrl: callbackUrl(),
      webhookSecret: WEBHOOK_SECRET,
      input: {
        text: (params.text as string) ?? '',
        voiceId: (params.voiceId as string) ?? '',
        speed: (params.speed as number) ?? 1.0,
        vol: (params.vol as number) ?? 1.0,
        pitch: (params.pitch as number) ?? 0,
        emotion: (params.emotion as string) ?? 'neutral',
      },
      metadata: { taskId },
    }),
  });

  if (!resp.ok) throw new Error(`media-worker ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { jobId: string };
  await getFirestore().collection(COL.tasks).doc(taskId).update({
    status: 'running',
    resultRef: `mw_jobs/${data.jobId}`,
  });
}

async function enqueueWritingJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // 未來接 strategy-worker，目前佔位
  throw new Error('writing worker not yet connected');
}

async function enqueueWebSearchJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // 未來接 search-worker，目前佔位
  throw new Error('web_search worker not yet connected');
}
