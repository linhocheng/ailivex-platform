/**
 * Cloud Run Job 入口（ailivex-podcast-job）
 *
 * 為什麼：podcast 長生成在 min-instances=0 的 service 上會被閒置回收砍掉；
 * Jobs 跑到完成才結束、按執行時間計費、零常駐。
 *
 * 呼叫方式：Vercel 以 Jobs API 執行，env override 傳入
 *   TASK_ID    — tasks/{id}
 *   JOB_ACTION — script | audio
 * 參數一律從 Firestore task doc 讀（generate-script route 建 task 時已寫入；
 * generate-audio route 派工前已把過濾後的 script 寫回 doc）。
 * 業務失敗寫回 task doc 後 exit 0（不觸發 Jobs 重試）；環境層錯誤 exit 1。
 */
import { db, loadCharacters, runScriptWork, runAudioWork } from './index.js';
import type { PodcastLine as AudioLine } from './audio.js';

const TASK_ID = (process.env.TASK_ID ?? '').trim();
const JOB_ACTION = (process.env.JOB_ACTION ?? '').trim();

async function main(): Promise<void> {
  if (!TASK_ID || !['script', 'audio'].includes(JOB_ACTION)) {
    throw new Error(`需要 TASK_ID 與 JOB_ACTION(script|audio)，收到 action=${JOB_ACTION}`);
  }

  const taskRef = db.collection('tasks').doc(TASK_ID);
  const snap = await taskRef.get();
  if (!snap.exists) throw new Error(`task ${TASK_ID} 不存在`);
  const task = snap.data() as {
    status?: string;
    podcastScript?: AudioLine[];
    podcastCharacterIds?: string[]; podcastTopic?: string; podcastWordCount?: number; podcastFocus?: string;
    podcastEpisodeGoal?: string;
    podcastAudiencePersona?: string; podcastAudienceMisconception?: string;
    podcastCharacterBriefs?: Record<string, string>;
  };

  console.log(`[podcast-job] start action=${JOB_ACTION} taskId=${TASK_ID}`);

  if (JOB_ACTION === 'script') {
    if (task.status === 'scripted' || task.status === 'done') {
      console.log('[podcast-job] already done, skip');
      return;
    }
    const characterIds = task.podcastCharacterIds ?? [];
    if (characterIds.length === 0) {
      await taskRef.update({ status: 'failed', error: '未指定角色' });
      return;
    }
    const characters = await loadCharacters(characterIds);
    if (characters.length === 0) {
      await taskRef.update({ status: 'failed', error: '找不到角色' });
      return;
    }
    await runScriptWork(TASK_ID, characters, task.podcastTopic, task.podcastWordCount, task.podcastFocus, task.podcastEpisodeGoal,
      { persona: task.podcastAudiencePersona, misconception: task.podcastAudienceMisconception },
      task.podcastCharacterBriefs);

  } else {
    const lines = task.podcastScript ?? [];
    if (lines.length === 0) {
      await taskRef.update({ status: 'failed', error: '尚未有腳本' });
      return;
    }
    await taskRef.update({ status: 'running', podcastPhase: 'audio_pending' });
    await runAudioWork(TASK_ID, lines);
  }

  console.log(`[podcast-job] finished action=${JOB_ACTION} taskId=${TASK_ID}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[podcast-job] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
