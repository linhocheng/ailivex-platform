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
import { loadPatterns, filterLine, scanText } from './text-filter.js';
import { generateAudio, type PodcastLine as AudioLine } from './audio.js';
import {
  MOVES, newRhythmState, buildConstraints, recordLine, stripLeadingTic,
  vetoRepeatedMove, computeStats, detectLeadingTic,
} from './rhythm.js';
import { runDuoScript } from './acts.js';

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
export const db = getFirestore();

// ── Types ──────────────────────────────────────────────────────────────
import type { VoiceBlock } from './duo-types.js';

export interface Character {
  id: string;
  name: string;
  soul: string;
  soulCore?: string;
  voice?: VoiceBlock; // persona.voice（Voice Layer；duo 管線用）
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

// 長呼叫（>95s）必須繞開 Cloudflare 的 100s 斷頭鍘（524）：走 BRIDGE_DIRECT_URL 直連。
// BRIDGE_URL 本身已是直連（host 含 bridge-direct）時視同直連；兩者皆無才夾超時——
// 等一個注定 524 的回應是浪費。
const BRIDGE_DIRECT_BASE = (process.env.BRIDGE_DIRECT_URL ?? '').replace(/\/v1\/messages\/?$/, '').replace(/\/$/, '')
  || (BRIDGE_BASE.includes('bridge-direct') ? BRIDGE_BASE : '');
const CF_GUILLOTINE_MS = 95_000;

async function bridgeCall(model: string, system: string, user: string, maxTokens: number, timeoutMs = 90_000): Promise<string> {
  let endpoint = BRIDGE_ENDPOINT;
  if (timeoutMs > CF_GUILLOTINE_MS) {
    if (BRIDGE_DIRECT_BASE) {
      endpoint = `${BRIDGE_DIRECT_BASE}/v1/messages`;
    } else {
      console.warn(`[bridge] 長呼叫（${timeoutMs}ms）但 BRIDGE_DIRECT_URL 未設，超時夾至 ${CF_GUILLOTINE_MS}ms（CF 524 防浪費）`);
      timeoutMs = CF_GUILLOTINE_MS;
    }
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BRIDGE_SECRET },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
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
): Promise<{ nextCharacterId: string; taskForChar: string; move: string }> {
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
  const moveList = MOVES.map((m, i) => `${i}. ${m}`).join('\n');

  try {
    const raw = await bridgeCall(
      'claude-haiku-4-5-20251001',
      `你是多人語音對話場控。\n角色：\n${charList}\n主題：${topic || '（無）'}\n焦點：${focus || '（無）'}\n階段：${stage}（${stageNote[stage]}）\n輪次：${turn + 1}/${maxTurns}，上一位：${lastSpeaker || '無'}\n接話動作盤（挑最適合當下脈絡的一個，讓對話有攻有守、有稜有角，不要每輪都溫和）：\n${moveList}\n輸出純JSON（不加markdown）：{"nextCharacterId":"id","taskForChar":"場域說明≤40字","moveIndex":0}`,
      historyToText(history, 4) || '（對話剛開始）',
      150,
    );
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const p = JSON.parse(jsonStr) as { nextCharacterId: string; taskForChar: string; moveIndex?: number };
    const valid = characters.find(c => c.id === p.nextCharacterId);
    const mi = typeof p.moveIndex === 'number' && p.moveIndex >= 0 && p.moveIndex < MOVES.length ? p.moveIndex : turn % MOVES.length;
    return {
      nextCharacterId: valid ? p.nextCharacterId : fallbackId,
      taskForChar: (p.taskForChar ?? '').slice(0, 60),
      move: MOVES[mi],
    };
  } catch {
    return { nextCharacterId: fallbackId, taskForChar: '', move: MOVES[turn % MOVES.length] };
  }
}

/** 收尾判斷：最後兩句是否已自然收束（是 → 跳過強制收尾輪） */
async function isAlreadyClosed(history: PodcastLine[]): Promise<boolean> {
  if (history.length < 2) return false;
  try {
    const raw = await bridgeCall(
      'claude-haiku-4-5-20251001',
      '你判斷一段多人對話是否已經自然收束（語氣落定、話題閉合、不再拋新問題）。只輸出純JSON：{"closed":true} 或 {"closed":false}',
      history.slice(-3).map(l => `[${l.speaker}]: ${l.text}`).join('\n'),
      30,
    );
    const p = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()) as { closed?: boolean };
    return p.closed === true;
  } catch {
    return false;
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
  constraints: string[] = [],
  move = '',
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
- 你有自己的立場和脾氣。認同就認同，不認同就直說，被挑戰時可以堅持、可以反駁
- 不要以複述或稱讚對方的話開場——直接說你自己的
- 只推進一個想法，不要一次說完所有觀點
- 留下下一位可以接的空間

輸出格式（只輸出這一行，不加任何其他說明）：
[${character.name}]: 台詞`,
      `目前對話：
${recentHistory || '（對話剛開始，你是第一個開口的）'}

${lastLine ? `上一句：${lastLine}\n` : ''}場域狀態：${taskForChar || '把話題自然引入'}
${move && kind === 'normal' ? `這一輪的接話方式：${move}\n` : ''}${constraints.length ? `本輪注意：\n${constraints.map(c => `- ${c}`).join('\n')}\n` : ''}字數提示：${kind === 'reaction' ? '20 到 40 字的簡短回應。' : budgetHint}

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
  const rhythm = newRhythmState();
  const namesExcept = (c: Character) => characters.filter(x => x.id !== c.id).map(x => x.name);

  // 過濾在入史前做：踩雷句不進對話歷史，後續輪次才不會被帶壞跟著寫
  const pushLine = async (raw: string, char: Character, opts?: { bannedTic?: boolean; move?: string }) => {
    const match = raw.match(/^\[([^\]]+)\][:：]\s*([\s\S]+)/);
    const sp = match ? match[1].trim() : char.name;
    let rawText = match ? match[2].trim()
      : raw.replace(/^\[.*?\][:：]\s*/, '').trim() || raw.trim();
    // 保底：禁令下了還是用語氣詞開頭 → 程式刪掉
    if (opts?.bannedTic && detectLeadingTic(rawText)) rawText = stripLeadingTic(rawText);
    const { text, hits } = await filterLine(
      rawText, char.name, (char.soulCore || char.soul).slice(0, 800),
      historyToText(history, 3), filterPatterns, bridgeCall,
    );
    if (hits.length > 0) {
      console.log(`[text-filter] ${char.name} 踩雷 ${hits.map(h => h.matched).join('、')} → 已改寫`);
    }
    recordLine(rhythm, char.id, text, namesExcept(char), opts?.move);
    history.push({ speaker: sp, characterId: nameToId[sp] ?? char.id, text });
  };

  for (let turn = 0; turn < hardLimit; turn++) {
    const stage = getStage(turn, maxTurns);
    const ctl = await runSceneController(
      characters, history, topic, focus, stage, turn, maxTurns,
    );
    const char = characters.find(c => c.id === ctl.nextCharacterId) ?? characters[turn % characters.length];
    const accumulated = history.reduce((s, l) => s + l.text.length, 0);
    // 輪次類型（機制用程式定）：第 0 輪開場；中段每 5 輪穿插一次短反應
    const kind: TurnKind = turn === 0 ? 'opening'
      : (stage === '中段' && turn % 5 === 3) ? 'reaction'
      : 'normal';
    const move = vetoRepeatedMove(rhythm, char.id, ctl.move);
    const constraints = buildConstraints(rhythm, char.id, namesExcept(char));
    const raw = await generateCharacterTurn(
      char, history, topic, focus, ctl.taskForChar, stage, accumulated, wordCount,
      namesExcept(char), kind, constraints, move,
    );
    if (raw.trim()) await pushLine(raw, char, { bannedTic: constraints.some(c => c.includes('語氣詞')), move });

    const newAcc = history.reduce((s, l) => s + l.text.length, 0);
    if (newAcc >= wordCount * 1.1) break;
    if (stage === '後段' && newAcc >= wordCount * 0.85) break;
  }

  if (history.length === 0) throw new Error('腳本生成失敗，請重試。');

  // 收尾輪：先問場控「已自然收束了嗎」，收束了就不畫蛇添足
  if (!(await isAlreadyClosed(history))) {
    const opener = characters.find(c => c.id === history[0].characterId) ?? characters[0];
    const lastSpeakerId = history[history.length - 1].characterId;
    const closer = opener.id !== lastSpeakerId ? opener
      : characters.find(c => c.id !== lastSpeakerId) ?? opener;
    const closingAcc = history.reduce((s, l) => s + l.text.length, 0);
    const closingConstraints = buildConstraints(rhythm, closer.id, namesExcept(closer));
    const closingRaw = await generateCharacterTurn(
      closer, history, topic, focus, '自然收尾', '後段', closingAcc, wordCount + 80,
      namesExcept(closer), 'closing', closingConstraints,
    );
    if (closingRaw.trim()) await pushLine(closingRaw, closer, { bannedTic: closingConstraints.some(c => c.includes('語氣詞')) });
  } else {
    console.log('[podcast-worker] 對話已自然收束，跳過強制收尾輪');
  }

  // 殺青後：角色自審——程式遞鏡子（統計數據），角色以自己的靈魂為標準改
  await selfReview(history, characters, filterPatterns);

  return history;
}

// ── 角色自審（殺青後）───────────────────────────────────────────────
// 程式負責讓他看見（事實），靈魂負責讓他判斷（像不像我），程式再確認他真的改了
async function selfReview(
  history: PodcastLine[],
  characters: Character[],
  filterPatterns: Awaited<ReturnType<typeof loadPatterns>>,
): Promise<void> {
  for (const char of characters) {
    const otherNames = characters.filter(x => x.id !== char.id).map(x => x.name);
    const stats = computeStats(history, char.id, otherNames);
    if (stats.turns < 3) continue;

    const transcript = history.map((l, i) => `${i + 1}. [${l.speaker}]: ${l.text}`).join('\n');
    const statLine = `你共發言 ${stats.turns} 輪；其中 ${stats.ticCount} 輪以${stats.ticExamples.join('、') || '語氣詞'}開頭；${stats.echoCount} 輪以複述或稱讚對方開場。`;

    try {
      const raw = await bridgeCall(
        'claude-sonnet-4-6',
        `你是${char.name}。以下是你完整的角色意識、價值觀、語氣與說話態度：

${(char.soulCore || char.soul).slice(0, 1500)}

你剛錄完一場多人對話。下面會給你全場逐字稿，以及你的行為統計（由程式統計，數字是事實，不要懷疑）。

${statLine}

用你自己的標準回看你說的每一句話，問：這像不像我？
- 重複的口頭禪、機械式的開場——同一招用兩次以上就假了，改成你真正會說的話
- 你讓步得太快、同意得太便宜、該堅持沒堅持的地方——改回你真正的立場。你有脾氣、有稜有角，不是好好先生
- 已經像你的句子，一個字都不要動

輸出格式：只列需要修改的句子，一行一句：
行號: 修改後的完整台詞（不含名字標記）
全部都像你就只輸出：無`,
        transcript,
        1500,
      );
      const trimmed = raw.trim();
      if (!trimmed || trimmed === '無') continue;

      let applied = 0;
      for (const line of trimmed.split('\n')) {
        const m = line.match(/^(\d+)[.、]?\s*[:：]\s*(.+)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10) - 1;
        const newText = m[2].trim().replace(/^\[.*?\][:：]\s*/, '');
        // 只准改自己的句子，且不能改空
        if (idx < 0 || idx >= history.length || history[idx].characterId !== char.id || !newText) continue;
        const residual = scanText(newText, filterPatterns);
        if (residual.length > 0) {
          console.warn(`[self-review] ${char.name} 改寫句帶 AI 味，保留原句: ${residual.map(h => h.matched).join('、')}`);
          continue;
        }
        history[idx].text = newText;
        applied++;
      }
      // 程式複核：改完再數一次，留下前後對照的證據
      const after = computeStats(history, char.id, otherNames);
      console.log(`[self-review] ${char.name} 改了 ${applied} 句 | 語氣詞開頭 ${stats.ticCount}→${after.ticCount} | 複述開場 ${stats.echoCount}→${after.echoCount}`);
    } catch (err) {
      console.warn(`[self-review] ${char.name} 自審失敗，保留原稿: ${err instanceof Error ? err.message : err}`);
    }
  }
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

  const { taskId, characterIds, topic, wordCount, focus, episodeGoal, audiencePersona, audienceMisconception, characterBriefs } = req.body as {
    taskId?: string;
    characterIds?: string[];
    topic?: string;
    wordCount?: number;
    focus?: string;
    episodeGoal?: string;
    audiencePersona?: string;
    audienceMisconception?: string;
    characterBriefs?: Record<string, string>;
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
  const characters = await loadCharacters(characterIds);

  if (characters.length === 0) {
    await taskRef.update({ status: 'failed', error: '找不到角色' });
    res.status(400).json({ error: '找不到角色' });
    return;
  }

  // 先回 202（Vercel 10s 後 abort 的 AbortSignal 安全著陸）
  res.status(202).json({ status: 'accepted', taskId });

  setImmediate(() => runScriptWork(taskId, characters, topic, wordCount, focus, episodeGoal,
    { persona: audiencePersona, misconception: audienceMisconception }, characterBriefs));
});

/** 依 id 載入角色（route 與 job 入口共用） */
export async function loadCharacters(characterIds: string[]): Promise<Character[]> {
  const charSnaps = await Promise.all(characterIds.map((id: string) => db.collection('characters').doc(id).get()));
  return charSnaps
    .map((s, i) => {
      if (!s.exists) return null;
      const d = s.data() as { name: string; soul: string; soulCore?: string; voice?: VoiceBlock };
      const ch: Character = { id: characterIds[i], name: d.name, soul: d.soul, soulCore: d.soulCore, voice: d.voice };
      return ch;
    })
    .filter((c): c is Character => c !== null);
}

/** 腳本生成本體（route 背景與 Cloud Run Job 共用）。錯誤寫回 task doc，不往外丟。 */
export async function runScriptWork(
  taskId: string, characters: Character[], topic?: string, wordCount?: number, focus?: string, episodeGoal?: string,
  audience?: { persona?: string; misconception?: string },
  characterBriefs?: Record<string, string>,
): Promise<void> {
  const taskRef = db.collection('tasks').doc(taskId);
  try {
    console.log(`[podcast-worker] start taskId=${taskId} chars=${characters.map(c => c.name).join('×')} words=${wordCount ?? 600} mode=${characters.length === 2 ? 'duo' : 'legacy'}`);

    // 雙人 → duo 協議管線（規格書 v1）；三人以上 → legacy（多人版之後也聽 Producer）
    if (characters.length === 2) {
      const filterPatterns = await loadPatterns(db);
      const result = await runDuoScript(db, bridgeCall, characters, {
        taskId, episodeGoal, topic, focus, audience,
        briefs: characterBriefs,
        wordCount: wordCount ?? 600,
        filterPatterns,
      });
      // 收斂已由無形製作人的收斂台完成（儀器掃描→裁決→角色重講）；
      // 舊 selfReview（角色自審）退役——重講的人就是角色本人，「像不像我」被 retake 迴圈天然吸收
      const script: PodcastLine[] = result.turns.map(t => ({
        speaker: t.speaker, characterId: t.characterId,
        // 確定性修復（收斂點）：模型偶發輸出字面 \n → 還原成真換行（程式修，不 re-ask）
        text: t.utterance.replace(/\\n/g, '\n'),
      }));
      result.turns.forEach((t, i) => { t.utterance = script[i].text; });
      await taskRef.update({
        status: 'scripted',
        podcastScript: script,
        podcastPhase: 'script_done',
        podcastMode: 'duo',
        podcastEpisodeGoal: result.meta.episodeGoal,
        podcastAudiencePersona: result.audience.persona,
        podcastAudienceMisconception: result.audience.misconception,
        ...(result.seriesContext ? { podcastSeriesContext: result.seriesContext } : {}),
        ...(result.tensionMap ? { podcastTensionMap: result.tensionMap } : {}),
        ...(result.collisionQuestions ? { podcastCollisionQuestions: result.collisionQuestions } : {}),
        ...(result.producerEpilogue ? { podcastProducerEpilogue: result.producerEpilogue } : {}),
        ...(result.convergence ? { podcastConvergence: result.convergence } : {}),
        podcastBeliefStates: result.beliefs,
        podcastTurns: result.turns.map(t => JSON.parse(JSON.stringify(t))),      // 剝 undefined
        podcastProducerEvents: result.producerEvents,
        podcastEpisodeMeta: JSON.parse(JSON.stringify(result.meta)),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[podcast-worker] duo done taskId=${taskId} lines=${script.length} deltas=${result.meta.beliefDeltas.length}`);
      return;
    }

    const script = await generateScript(characters, topic, wordCount ?? 600, focus);
    await taskRef.update({
      status: 'scripted',
      podcastScript: script,
      podcastPhase: 'script_done',
      podcastMode: 'legacy',
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[podcast-worker] done taskId=${taskId} lines=${script.length} chars=${script.reduce((s, l) => s + l.text.length, 0)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[podcast-worker] error taskId=${taskId}: ${msg}`);
    await taskRef.update({ status: 'failed', error: msg }).catch(() => {});
  }
}

// 音檔生成：Vercel fire-and-forget 過來，202 後背景跑（同腳本生成的模式）
app.post('/run-audio', async (req, res) => {
  const auth = req.headers['x-worker-secret'];
  if (!WORKER_SECRET || auth !== WORKER_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { taskId, script } = req.body as { taskId?: string; script?: AudioLine[] };
  if (!taskId) {
    res.status(400).json({ error: 'taskId 必填' });
    return;
  }

  const taskRef = db.collection('tasks').doc(taskId);
  const snap = await taskRef.get();
  if (!snap.exists) {
    res.status(404).json({ error: 'task not found' });
    return;
  }

  // 用傳入的 script（已編輯），否則讀 Firestore
  const lines: AudioLine[] = script?.length ? script : (snap.data()?.podcastScript ?? []);
  if (lines.length === 0) {
    res.status(400).json({ error: '尚未有腳本' });
    return;
  }
  if (script?.length) await taskRef.update({ podcastScript: script });
  await taskRef.update({ status: 'running', podcastPhase: 'audio_pending' });

  res.status(202).json({ status: 'accepted', taskId });

  setImmediate(() => runAudioWork(taskId, lines));
});

/** 音檔生成本體（route 背景與 Cloud Run Job 共用）。錯誤寫回 task doc，不往外丟。 */
export async function runAudioWork(taskId: string, lines: AudioLine[]): Promise<void> {
  const taskRef = db.collection('tasks').doc(taskId);
  try {
    console.log(`[podcast-worker] audio start taskId=${taskId} lines=${lines.length}`);
    const audioUrl = await generateAudio(taskId, lines, BRIDGE_ENDPOINT, BRIDGE_SECRET);
    console.log(`[podcast-worker] audio done taskId=${taskId} url=${audioUrl.split('?')[0]}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[podcast-worker] audio error taskId=${taskId}: ${msg}`);
    await taskRef.update({ status: 'failed', error: msg }).catch(() => {});
  }
}

// Cloud Run Job 模式（JOB_MODE=1，入口 dist/job.js）時不開 HTTP server
if (!process.env.JOB_MODE) {
  app.listen(PORT, () => {
    console.log(`[podcast-worker] listening on :${PORT}`);
  });
}
