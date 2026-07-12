/**
 * L3 協議層 — THINK / SPEAK 兩次獨立生成（Voice Layer 規格書 v1，P1/P2）
 *
 * BUG-A（協議洩漏）的病根：思考和說話在同一口氣裡生成，台詞被它剛寫完的
 * 格式污染——角色開始「報告」自己的對話動作而不是「執行」它。
 * 修法：
 *   PASS 1 THINK — 產出結構化 thought（heard/stance/cost/intent），只存 state
 *   PASS 2 SPEAK — 看不到任何欄位名稱與協議語言，thought 只以「結論」傳入
 * history 永遠只回灌 utterance（本來就是），thought 一次都不准進 prompt history。
 * JSON 壞了重生成，不 re-ask 模型修（天條）。
 */
import {
  type DuoChar, type BeliefState, type CorpusEntry, type Stance,
  type AudienceMirror, type BridgeCall, DUO_MODEL, extractJson, stripModelTokens,
} from './duo-types.js';
import type { Violation } from './validators.js';
import { corpusMenu } from './belief.js';

export interface HistoryLine {
  speaker: string; // 角色名或「製作人」
  text: string;
}

/** PASS 1 產物 — 只存 DialogueState，永不回灌任何 prompt 的 history 區段 */
export interface Thought {
  heard: string;
  stance: Stance;
  partialDetail?: string;
  cost: { before: string; after: string } | null; // 反駁的價（= 舊 concession）
  intent: string;                                  // 這一輪要達成什麼，動詞開頭
  evidenceRefs: string[];                          // 素材庫條目 id
  beliefDelta: string | null;
  audienceResonance: string | null;                // 第 7 步：能幫台下的人打破什麼（沒有就 null）
}

const STANCES: Stance[] = ['ACCEPT', 'PARTIAL', 'REJECT'];

function contextBlock(history: HistoryLine[]): string {
  return history.slice(-8).map(l => `[${l.speaker}]: ${l.text}`).join('\n')
    || '（對話剛開始，你是第一個開口的）';
}

// ── PASS 1 · THINK ────────────────────────────────────────────────────

export async function thinkTurn(
  bridgeCall: BridgeCall,
  char: DuoChar,
  belief: BeliefState,
  corpus: CorpusEntry[],
  opponentName: string,
  episodeGoal: string,
  audience: AudienceMirror | null,
  brief: string | undefined,
  focus: string | undefined,
  history: HistoryLine[],
  actContext: string,
  violations: Violation[],
): Promise<Thought | null> {
  const system = `你是${char.name}。以下是你完整的角色意識、價值觀、思考方式：

${char.soulCore || char.soul}
${brief?.trim() ? `\n## 製作人開錄前私下跟你交代（只有你聽到）\n「${brief.trim()}」\n` : ''}
## 你的立場狀態（整場維護）
CORE_CLAIM（核心主張）：${belief.coreClaim}
WEAKEST_POINT（你最沒把握的一點，對方有權攻打，你不得閃躲）：${belief.weakestPoint}
WHAT_WOULD_CHANGE_ME（什麼會讓你改變想法）：${belief.whatWouldChangeMe}
OUT_OF_SCOPE（你不談的，碰到就承認不知道）：${belief.outOfScope}

你在和${opponentName}錄一集雙人對話，這一集要回答：「${episodeGoal}」
${focus?.trim() ? `節目擁有者交代這一集的焦點（對話要談到它）：「${focus.trim()}」\n` : ''}
${audience ? `## 這集做給誰聽（編輯羅盤——放在心裡衡量，不對他喊話，他不在現場）
受眾輪廓：${audience.persona}
他常帶著的誤解：${audience.misconception}

` : ''}## 你的素材庫（你擁有的全部真實案例；庫裡沒有的真實案例不存在，不可虛構）
${corpusMenu(corpus)}`;

  const fixBlock = violations.length
    ? `\n\n⚠️ 你上一版思考被退回，逐條修正：\n${violations.map(v => `- ${v.detail}`).join('\n')}`
    : '';

  const user = `## 對話至此
${contextBlock(history)}

${actContext}

## 你現在要做的事：想，不要說
這一輪你只在心裡處理。沒有人會聽到這一段。

1. HEARD — 對方剛剛的主張是什麼？一句話。必須是對方看了會點頭的版本，不准加轉折。（你是第一個開口的話填空字串）
2. STANCE — ACCEPT / PARTIAL / REJECT。PARTIAL 要說清楚：哪一部分接受、哪一部分不接受。
3. COST — 如果你打算反駁（REJECT），你必須先付錢：我原本主張__，因為對方剛說的，我把它修正成__。付不出這筆錢你這一輪就不准反駁——只剩兩條路：(a) 問一個你真的不知道答案的問題 (b) 往前推進，不回頭。
4. INTENT — 這一輪你講出來的話要達成什麼？一句話，動詞開頭。
5. EVIDENCE — 這一輪要用素材庫哪些條目？填條目 id，沒有就空陣列。
6. BELIEF_DELTA — 你的核心主張或軟肋有沒有被剛剛的話動到？有就寫一句話，沒有填 null。對方碰到你的 WHAT_WOULD_CHANGE_ME 時你必須誠實移動——這不是投降，是這場對話成功了。${audience ? `
7. RESONANCE — 你這一輪準備說的話，對「${audience.persona}」那種人有什麼用？一句話。沒有就填 null，不要硬掰——不是每一句話都要有用。` : ''}${fixBlock}

只輸出 JSON，不要說話：
{"heard":"...","stance":"ACCEPT|PARTIAL|REJECT","partialDetail":"...","cost":{"before":"...","after":"..."}或null,"intent":"...","evidenceRefs":[],"beliefDelta":"...或null"${audience ? ',"audienceResonance":"...或null"' : ''}}`;

  const raw = await bridgeCall(DUO_MODEL, system, user, 550);
  const p = extractJson<{
    heard?: string; stance?: string; partialDetail?: string;
    cost?: { before?: string; after?: string } | null;
    intent?: string; evidenceRefs?: string[]; beliefDelta?: string | null;
    audienceResonance?: string | null;
  }>(raw);
  if (!p || !p.intent?.trim()) return null;

  const cost = p.cost?.before?.trim() && p.cost?.after?.trim()
    ? { before: p.cost.before.trim(), after: p.cost.after.trim() }
    : null;
  const cleanNullable = (v: unknown) =>
    typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null;

  return {
    heard: (p.heard ?? '').trim(),
    stance: STANCES.includes(p.stance as Stance) ? (p.stance as Stance) : 'PARTIAL',
    partialDetail: (p.partialDetail ?? '').trim() || undefined,
    cost,
    intent: p.intent.trim(),
    evidenceRefs: Array.isArray(p.evidenceRefs) ? p.evidenceRefs.filter(r => typeof r === 'string' && r.trim()) : [],
    beliefDelta: cleanNullable(p.beliefDelta),
    audienceResonance: cleanNullable(p.audienceResonance),
  };
}

// ── PASS 2 · SPEAK ────────────────────────────────────────────────────

export interface SpeakRetry {
  offendingSpan: string;
  why: string;
  hint: string;
}

export async function speakTurn(
  bridgeCall: BridgeCall,
  char: DuoChar,
  opponentName: string,
  episodeGoal: string,
  topic: string | undefined,
  belief: BeliefState,           // 白話餵入（不帶欄位名）：你的完整與你的脆弱
  audience: AudienceMirror | null, // 編輯羅盤（不在現場，不對他喊話）；null＝純開放議題
  history: HistoryLine[],
  actContext: string,
  thought: Thought,
  evidence: CorpusEntry[],       // thought.evidenceRefs 解析後的實體
  retry: SpeakRetry | null,
): Promise<string> {
  const v = char.voice;
  const voiceBlock = v ? [
    v.rhythm ? `節奏：${v.rhythm}` : '',
    v.habits ? `慣性：${v.habits}` : '',
    v.evidenceStyle ? `舉證：${v.evidenceStyle}` : '',
    v.whenUncertain ? `不知道的時候：${v.whenUncertain}` : '',
    v.forbiddenRegister ? `你的禁區：${v.forbiddenRegister}` : '',
  ].filter(Boolean).join('\n') : '';
  const system = `你是${char.name}。以下是你完整的角色意識、價值觀、語氣與說話態度：

${char.soulCore || char.soul}
${voiceBlock ? `\n## 你說話的樣子\n${voiceBlock}\n` : ''}
## 你為什麼在這裡
你和${opponentName}在錄一集對話節目。${topic?.trim() ? `主題：${topic.trim()}。` : ''}這一集要回答：「${episodeGoal}」
${audience ? `這集是做給「${audience.persona}」這種人聽的——他們常帶著誤解：「${audience.misconception}」。讓他們聽完用得上。但他們不在現場：你是在跟${opponentName}對話，不是對任何人廣播。
` : ''}這場對話不是要贏過${opponentName}。是把這個問題真的談出東西來。

## 你的完整與你的脆弱
你堅信：${belief.coreClaim}。
你也知道自己最沒把握的是：${belief.weakestPoint}。不用藏。被打中的時候，誠實地動——讓步不是認輸，是這場對話成功了。`;

  const conclusions = [
    thought.intent,
    thought.cost ? `你已經把你的立場修正成：${thought.cost.after}` : '',
    thought.audienceResonance ? `你隱約覺得，這番話對聽的人有用的地方：${thought.audienceResonance}` : '',
    evidence.length
      ? `你手上的真實素材（要用就用裡面的具體內容，人名、數字、當下發生的事）：\n${evidence.map(e => `- ${e.title}｜${e.sectionRef}｜${e.excerpt}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  const retryBlock = retry
    ? `\n\n## ⛔ 上一版被退回
你寫了：「${retry.offendingSpan}」
問題：${retry.why}

重講。不要修那一句——重新開口。
${retry.hint}`
    : '';

  const user = `## 對話至此
${contextBlock(history)}

${actContext}

## 你剛剛在心裡的結論
${conclusions}

## 現在：開口
⚠️ 你剛才的那些思考，已經發生了。不要報告它。讓它顯示在你接下來說的話裡。

### 你的權利（重要，不要放棄）
- 你可以說「這個我沒想過」，然後停住
- 你可以說「對」，然後不補充
- 你可以問一個問題，然後閉嘴等
- 你可以講到一半，收回，重新說
- 你可以暴露自己狼狽、失手、手抖的時刻。聽的人因為看見你的脆弱而靠近
- 你不需要每一輪都貢獻新東西。真人不會。

### 只有兩條禁忌
- 不准 AI 公關腔（「這是一個很好的問題」「正如你所說」這類話一出口，人就走了）
- 不准為了贏而辯。被說服的時候，就讓它發生

### 一條提醒（動作層級）
真人做，不報。不要宣告你此刻在對話裡做什麼（宣布同意或反駁、宣告分歧、宣告今天帶走什麼）——直接從「聽到之後」開始講。讓步的樣子可以是沉默、換題、語氣變軟，不必宣布轉彎。${retryBlock}

只輸出你說出口的話。不加名字標記、不加任何說明。`;

  const raw = await bridgeCall(DUO_MODEL, system, user, 400);
  const t = stripModelTokens(raw).replace(/^\[.*?\][:：]\s*/, '');
  // 只剝「整句被引號包住」的外框；句中引用（「翻譯」這個字…）不能動，否則引號失衡
  const wrapped = t.match(/^["「『]([^「」『』]*)["」』]$/s);
  return wrapped ? wrapped[1].trim() : t;
}
