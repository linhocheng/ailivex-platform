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
import { consumeMediaQuota, QuotaExceededError } from '@/lib/quota';

// 直接產出付費媒體單位的能力（扣媒體額度）。story_draft/script_draft 是文字草稿不扣，
// 其後的實際生圖/生音在 generate-storyboard/generate-audio 各自扣，避免雙重計數。
const PAID_MEDIA_TYPES: ReadonlySet<TaskCapability> = new Set(['image_generation', 'audio_generation', 'video_generation']);

const MEDIA_WORKER_URL = cleanUrl(process.env.MEDIA_WORKER_URL);
const MEDIA_WORKER_KEY = cleanSecret(process.env.MEDIA_WORKER_KEY_AILIVEX);
const WEBHOOK_SECRET = cleanSecret(process.env.MEDIA_WORKER_WEBHOOK_SECRET);

function platformBase(): string {
  const base = process.env.PLATFORM_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return cleanUrl(base);
}

// media-worker 完成後回呼平台的 callback URL（穩定 production 域名）
function callbackUrl(): string {
  return `${platformBase()}/api/tasks/callback`;
}

// ── 路由表：capability → worker 呼叫函數 ──────────────────────────────
const WORKER_ROUTES: Record<TaskCapability, (taskId: string, params: Record<string, unknown>) => Promise<void>> = {
  image_generation: enqueueImageJob,
  audio_generation: enqueueAudioJob,
  writing: enqueueWritingJob,
  web_search: enqueueWebSearchJob,
  script_draft: enqueueScriptDraftJob,
  story_draft: enqueueStoryDraftJob,
  video_generation: enqueueVideoJob,
  // podcast_generation 由素材轉換區直接呼叫，不走 task-dispatcher
  podcast_generation: async () => {},
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

  // 媒體額度：直接產出付費媒體的能力先扣 1（不足 → 角色誠實告知，不建任務）。
  // 失敗退量走 tasks/callback（job.failed）。
  if (PAID_MEDIA_TYPES.has(type)) {
    try {
      await consumeMediaQuota(db, userId, 1);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return { taskId: '', message: '（媒體生成額度已用罄，本次未建立。如需增購請聯繫您的服務窗口。）' };
      }
      throw e;
    }
  }

  const ref = db.collection(COL.tasks).doc();
  const taskId = ref.id;

  const doc: Omit<TaskDoc, 'createdAt'> & Record<string, unknown> = {
    userId, characterId, type, intent, params,
    // script_draft: 角色已在對話裡寫好腳本，用戶確認後才生成音檔 → 'draft'
    // story_draft: 後台立即啟動 Phase A pipeline → 'pending'
    status: type === 'script_draft' ? 'draft' : 'pending',
    notified: false,
    ...(type === 'script_draft' && {
      scriptText: (params.text as string) ?? '',
      voiceId: (params.voiceId as string) ?? '',
    }),
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
  script_draft: '腳本草稿已備妥，你可以去媒體庫確認後生成音檔。',
  story_draft: '故事板已開始生成，系統會自動寫故事、分析圖卡腳本，你可以去故事板頁面查看進度。',
  video_generation: '分身短影音已開始生成，完成後你可以在媒體庫查看。',
  podcast_generation: 'Podcast 已生成，可前往素材轉換區查看。',
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

async function enqueueScriptDraftJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // script_draft 不走 media-worker：agent 直接寫 Firestore，此路由是佔位（不應被呼叫）
}

async function enqueueStoryDraftJob(taskId: string, _params: Record<string, unknown>): Promise<void> {
  const base = platformBase();
  const secret = cleanSecret(process.env.WORKER_SECRET);
  if (!base || !secret) { console.warn('[task-dispatcher] story_draft: PLATFORM_URL or WORKER_SECRET not set'); return; }
  // generate-story 快速回 200（LLM 在 after() 裡跑），await 確保 HTTP 請求確實送出
  await fetch(`${base}/api/tasks/${taskId}/generate-story`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(err => console.error('[task-dispatcher] generate-story trigger failed:', err instanceof Error ? err.message : String(err)));
}

async function enqueueVideoJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // video_generation 由用戶在媒體庫手動觸發（/api/tasks/[id]/generate-video），不走自動派送
}

async function enqueueWritingJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // 未來接 strategy-worker，目前佔位
  throw new Error('writing worker not yet connected');
}

async function enqueueWebSearchJob(_taskId: string, _params: Record<string, unknown>): Promise<void> {
  // 未來接 search-worker，目前佔位
  throw new Error('web_search worker not yet connected');
}
