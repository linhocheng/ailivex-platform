/**
 * ailivex podcast-worker (Cloud Run, asia-east1)
 *
 * 接 Vercel fire-and-forget → 跑 場控(Haiku)+角色(Sonnet)×N 輪 → 寫回 Firestore
 * ADC 不注入 SA JSON（天條：Cloud Run firebase-admin 一律走 ADC）
 * Bridge 走 BRIDGE_URL（Cloud Run asia-east1 → VM asia-east1-b，同 region 低延遲）
 */
import express from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { loadPatterns, filterLine } from './text-filter.js';

const PORT = Number(process.env.PORT) || 8080;
const WORKER_SECRET = (process.env.WORKER_SECRET ?? '').trim();
const BRIDGE_BASE = (process.env.BRIDGE_URL ?? '').replace(/\/v1\/messages\/?$/, '').replace(/\/$/, '');
const BRIDGE_ENDPOINT = `${BRIDGE_BASE}/v1/messages`;
const BRIDGE_SECRET = (process.env.BRIDGE_SECRET ?? '').trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID ?? 'ailivex-2026').trim();
const FIREBASE_STORAGE_BUCKET = (process.env.FIREBASE_STORAGE_BUCKET ?? '').trim();

// ADC — Cloud Run metadata server, 不用 cert
if (!getApps().length) {
  initializeApp({
    projectId: FIREBASE_PROJECT_ID,
    storageBucket: FIREBASE_STORAGE_BUCKET || undefined,
  });
}
const db = getFirestore();

// ── Types ──────────────────────────────────────────────────────────────
interface Character {
  id: string;
  name: string;
  soul: string;
  soulCore?: string;
}

interface PodcastLine {
  speaker: string;
  characterId: string;
  text: string;
}

type Stage = '前段' | '中段' | '後段';

// ── Helpers ────────────────────────────────────────────────────────────
function getStage(turn: number, maxTurns: number): Stage {
  const pct = turn / maxTurns;
  if (pct < 0.20) return '前段';
  if (pct < 0.85) return '中段';
  return '後段';
}

function historyToText(history: PodcastLine[], limit: number): string {
  return history.slice(-limit).map(l => `[${l.speaker}]: ${l.text}`).join('\n');
}

async function bridgeCall(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch(BRIDGE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BRIDGE_SECRET },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  const d = await res.json() as { content?: Array<{ text: string }> };
  return (d.content?.[0]?.text ?? '').trim();
}

// ── 場控（Haiku）─────────────────────────────────────────────────────
async function runSceneController(
  characters: Character[],
  history: PodcastLine[],
  topic: string | undefined,
  focus: string | undefined,
  stage: Stage,
  turn: number,
  maxTurns: number,
): Promise<{ nextCharacterId: string; taskForChar: string }> {
  const fallbackId = characters[turn % characters.length].id;
  const charList = characters.map((c, i) =>
    `第${i === 0 ? '一' : i + 1}聲音：${c.name}（id: ${c.id}）`
  ).join('\n');
  const stageNote: Record<Stage, string> = {
    '前段': '話題剛切入，角色各自從自身視角進入。',
    '中段': '核心討論，觀點碰撞推進，有認同也有反駁。',
    '後段': '準備自然收束，留下值得思考的落點，不做總結。',
  };
  const lastSpeaker = history.length > 0 ? history[history.length - 1].speaker : '';

  try {
    const raw = await bridgeCall(
      'claude-haiku-4-5-20251001',
      `你是多人語音對話場控。\n角色：\n${charList}\n主題：${topic || '（無）'}\n焦點：${focus || '（無）'}\n階段：${stage}（${stageNote[stage]}）\n輪次：${turn + 1}/${maxTurns}，上一位：${lastSpeaker || '無'}\n輸出純JSON（不加markdown）：{"nextCharacterId":"id","taskForChar":"場域說明≤40字"}`,
      historyToText(history, 4) || '（對話剛開始）',
      130,
    );
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const p = JSON.parse(jsonStr) as { nextCharacterId: string; taskForChar: string };
    const valid = characters.find(c => c.id === p.nextCharacterId);
    return {
      nextCharacterId: valid ? p.nextCharacterId : fallbackId,
      taskForChar: (p.taskForChar ?? '').slice(0, 60),
    };
  } catch {
    return { nextCharacterId: fallbackId, taskForChar: '' };
  }
}

// ── 角色發聲（Sonnet）────────────────────────────────────────────────
type TurnKind = 'opening' | 'normal' | 'reaction' | 'closing';

async function generateCharacterTurn(
  character: Character,
  history: PodcastLine[],
  topic: string | undefined,
  focus: string | undefined,
  taskForChar: string,
  stage: Stage,
  accumulated: number,
  wordCount: number,
  otherNames: string[],
  kind: TurnKind = 'normal',
): Promise<string> {
  const recentHistory = historyToText(history, 6);
  const lastLine = history.length > 0
    ? `[${history[history.length - 1].speaker}]: ${history[history.length - 1].text}`
    : '';
  const topicLine = topic?.trim() ? `本集主題：${topic.trim()}` : '';
  const focusLine = focus?.trim() ? `討論焦點：${focus.trim()}` : '';
  const remaining = Math.max(0, wordCount - accumulated);
  const budgetHint = remaining <= 60
    ? `對話快結束了，你只需要說一句話收束（約 ${remaining} 字以內）。`
    : `本輪請說 ${Math.min(remaining, 120)} 字以內，留下後面的空間給其他人接話。`;
  const stageHint = stage === '後段' && kind === 'normal'
    ? '對話進入收束。說出你此刻真正想留下的一句話——可以是問題、觀察、或一個還沒有答案的位置。不需要總結整集。'
    : '';
  const kindHint: Record<TurnKind, string> = {
    opening: `你是今天開場的人。今天你跟${otherNames.join('、')}坐在一起聊。用你自己的方式自然帶一下：跟誰碰面、要聊什麼，像兩個認識的人坐下來開聊，一兩句就進話題。不要播報式介紹、不要歡迎聽眾。`,
    normal: '',
    reaction: '這一輪你只是簡短回應——一聲認同、一個反問、或一句「你這樣講我倒想到⋯」的過渡。不用發展完整論點，20 到 40 字就好。',
    closing: '對話到這裡要結束了。用你自己的方式自然收掉——意識到今天聊到這裡了，可以留一句話給對方或聽的人。不要制式感謝收聽、不要總結全部觀點。',
  };

  try {
    return await bridgeCall(
      'claude-sonnet-4-6',
      `你不是在模仿一個角色。你就是此角色在本系統中的發言主體。

以下是你完整的角色意識、價值觀、思考方式、語氣與說話態度：

${character.soulCore || character.soul}

你現在在一場多人語音對話中。這不是傳統訪談，不是主持人與來賓，是不同角色之間的自然對話。

${topicLine}
${focusLine}
${stageHint}
${kindHint[kind]}

規則：
- 不要模仿，不要表演，不要替其他角色說話
${kind === 'opening' ? '- 不要播報式介紹、不要歡迎聽眾' : '- 不要歡迎聽眾、介紹節目、介紹自己'}
- 認同就認同，不認同就直說，不需要轉彎
- 只推進一個想法，不要一次說完所有觀點
- 留下下一位可以接的空間

輸出格式（只輸出這一行，不加任何其他說明）：
[${character.name}]: 台詞`,
      `目前對話：
${recentHistory || '（對話剛開始，你是第一個開口的）'}

${lastLine ? `上一句：${lastLine}\n` : ''}場域狀態：${taskForChar || '把話題自然引入'}
字數提示：${kind === 'reaction' ? '20 到 40 字的簡短回應。' : budgetHint}

現在輪到你（${character.name}）說話。`,
      200,
    );
  } catch (err) {
    console.warn(`[podcast-worker] Sonnet skip turn: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

// ── 主循環 ────────────────────────────────────────────────────────────
async function generateScript(
  characters: Character[],
  topic: string | undefined,
  wordCount: number,
  focus: string | undefined,
): Promise<PodcastLine[]> {
  const maxTurns = Math.round(wordCount / 80);
  const nameToId = Object.fromEntries(characters.map(c => [c.name, c.id]));
  const history: PodcastLine[] = [];
  const hardLimit = Math.ceil(maxTurns * 1.35);
  const filterPatterns = await loadPatterns(db);

  // 過濾在入史前做：踩雷句不進對話歷史，後續輪次才不會被帶壞跟著寫
  const pushLine = async (raw: string, char: Character) => {
    const match = raw.match(/^\[([^\]]+)\][:：]\s*([\s\S]+)/);
    const sp = match ? match[1].trim() : char.name;
    const rawText = match ? match[2].trim()
      : raw.replace(/^\[.*?\][:：]\s*/, '').trim() || raw.trim();
    const { text, hits } = await filterLine(
      rawText, char.name, (char.soulCore || char.soul).slice(0, 800),
      historyToText(history, 3), filterPatterns, bridgeCall,
    );
    if (hits.length > 0) {
      console.log(`[text-filter] ${char.name} 踩雷 ${hits.map(h => h.matched).join('、')} → 已改寫`);
    }
    history.push({ speaker: sp, characterId: nameToId[sp] ?? char.id, text });
  };
  const namesExcept = (c: Character) => characters.filter(x => x.id !== c.id).map(x => x.name);

  for (let turn = 0; turn < hardLimit; turn++) {
    const stage = getStage(turn, maxTurns);
    const { nextCharacterId, taskForChar } = await runSceneController(
      characters, history, topic, focus, stage, turn, maxTurns,
    );
    const char = characters.find(c => c.id === nextCharacterId) ?? characters[turn % characters.length];
    const accumulated = history.reduce((s, l) => s + l.text.length, 0);
    // 輪次類型（機制用程式定）：第 0 輪開場；中段每 5 輪穿插一次短反應
    const kind: TurnKind = turn === 0 ? 'opening'
      : (stage === '中段' && turn % 5 === 3) ? 'reaction'
      : 'normal';
    const raw = await generateCharacterTurn(
      char, history, topic, focus, taskForChar, stage, accumulated, wordCount, namesExcept(char), kind,
    );
    if (raw.trim()) await pushLine(raw, char);

    const newAcc = history.reduce((s, l) => s + l.text.length, 0);
    if (newAcc >= wordCount * 1.1) break;
    if (stage === '後段' && newAcc >= wordCount * 0.85) break;
  }

  if (history.length === 0) throw new Error('腳本生成失敗，請重試。');

  // 強制收尾輪：開場的人收尾；若他剛好是最後一個講的，換另一位
  const opener = characters.find(c => c.id === history[0].characterId) ?? characters[0];
  const lastSpeakerId = history[history.length - 1].characterId;
  const closer = opener.id !== lastSpeakerId ? opener
    : characters.find(c => c.id !== lastSpeakerId) ?? opener;
  const closingAcc = history.reduce((s, l) => s + l.text.length, 0);
  const closingRaw = await generateCharacterTurn(
    closer, history, topic, focus, '自然收尾', '後段', closingAcc, wordCount + 80, namesExcept(closer), 'closing',
  );
  if (closingRaw.trim()) await pushLine(closingRaw, closer);

  return history;
}

// ── Express ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ailivex-podcast-worker', ts: new Date().toISOString() });
});

app.post('/run', async (req, res) => {
  const auth = req.headers['x-worker-secret'];
  if (!WORKER_SECRET || auth !== WORKER_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { taskId, characterIds, topic, wordCount, focus } = req.body as {
    taskId?: string;
    characterIds?: string[];
    topic?: string;
    wordCount?: number;
    focus?: string;
  };

  if (!taskId || !Array.isArray(characterIds) || characterIds.length === 0) {
    res.status(400).json({ error: 'taskId + characterIds 必填' });
    return;
  }

  const taskRef = db.collection('tasks').doc(taskId);

  // 冪等：若已是 scripted/done 就跳過
  const snap = await taskRef.get();
  if (snap.exists) {
    const st = snap.data()?.status as string | undefined;
    if (st === 'scripted' || st === 'done') {
      res.json({ status: 'already_done' });
      return;
    }
  }

  // 先讀角色（驗證），回 202 後再跑生成
  const charSnaps = await Promise.all(characterIds.map((id: string) => db.collection('characters').doc(id).get()));
  const characters = charSnaps
    .map((s, i) => {
      if (!s.exists) return null;
      const d = s.data() as { name: string; soul: string; soulCore?: string };
      const ch: Character = { id: characterIds[i], name: d.name, soul: d.soul, soulCore: d.soulCore };
      return ch;
    })
    .filter((c): c is Character => c !== null);

  if (characters.length === 0) {
    await taskRef.update({ status: 'failed', error: '找不到角色' });
    res.status(400).json({ error: '找不到角色' });
    return;
  }

  // 先回 202（Vercel 10s 後 abort 的 AbortSignal 安全著陸）
  // --no-cpu-throttling + --min-instances=1 確保後台繼續跑不被 throttle
  res.status(202).json({ status: 'accepted', taskId });

  setImmediate(async () => {
    try {
      console.log(`[podcast-worker] start taskId=${taskId} chars=${characters.map(c => c.name).join('×')} words=${wordCount ?? 600}`);
      const script = await generateScript(characters, topic, wordCount ?? 600, focus);
      await taskRef.update({
        status: 'scripted',
        podcastScript: script,
        podcastPhase: 'script_done',
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[podcast-worker] done taskId=${taskId} lines=${script.length} chars=${script.reduce((s, l) => s + l.text.length, 0)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[podcast-worker] error taskId=${taskId}: ${msg}`);
      await taskRef.update({ status: 'failed', error: msg }).catch(() => {});
    }
  });
});

app.listen(PORT, () => {
  console.log(`[podcast-worker] listening on :${PORT}`);
});
