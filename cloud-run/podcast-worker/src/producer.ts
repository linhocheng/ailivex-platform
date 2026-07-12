/**
 * L4 導演層 — Producer（煞車／地心引力）
 *
 * 唯一持有目標的人。不辯論、不說金句、不製造深度感。
 * 觸發器確定性優先：假讓步計數、抽象度爬升、句長崩塌用程式算；
 * 只有「繞圈／無限後退／答案已出現」這種語意判斷交給 Sonnet 掃描（每 3 輪一次）。
 * LLM 沒有自然結束，只有耗盡——所以終止條件是交付物齊了，程式判。
 */
import {
  type DuoTurn, type ProducerEvent, type ProducerAction, type EpisodeMeta,
  type BeliefDeltaRecord, type BridgeCall, type DuoChar, type BeliefState,
  DUO_MODEL, extractJson,
} from './duo-types.js';
import { MOVE1_SEED_RE } from './validators.js';

export function producerSystem(episodeGoal: string, soul?: string | null, focus?: string): string {
  const focusLine = focus?.trim()
    ? `\n節目擁有者開錄前交代的焦點（這一集必須談到；收工前你要確認它真的被談到了）：「${focus.trim()}」`
    : '';
  if (soul) {
    return `${soul}

——以上是你的存在。你現在在玻璃後面，這一集要回答：「${episodeGoal}」${focusLine}

現場開口規則：你的話不進成品，但兩位來賓聽得到。短、硬、具體，三句以內。不替任何一方說話，不用讚美打斷節奏。`;
  }
  return `你是這集對話的製作人／導演。你不辯論、你不表演深度、你不說金句。你是這場對話裡唯一持有目標的人。

這一集要回答：「${episodeGoal}」${focusLine}

那兩個人的本能是贏，你的任務是讓他們交出作品。他們會往下挖，越挖越深、越挖越抽象，然後在一個沒有底的洞裡耗盡。你的工作是在洞變成墳墓之前把他們拉上來。

你的語氣：短、硬、具體，像一個看著時鐘的人。不客氣，不接住情緒，不用破折號堆節奏。三句話以內。`;
}

// ── 確定性觸發器 ───────────────────────────────────────────────────────

export interface TriggerState {
  fakeConcedeCount: number;
  lastLlmScanAt: number; // 上次 LLM 掃描的 turnId
}

export function newTriggerState(): TriggerState {
  return { fakeConcedeCount: 0, lastLlmScanAt: -1 };
}

/** 每輪過帳＋回傳確定性觸發（null = 不觸發） */
export function detectTrigger(state: TriggerState, turns: DuoTurn[]): ProducerAction | null {
  const last = turns[turns.length - 1];
  if (!last) return null;

  if (MOVE1_SEED_RE.test(last.utterance)) {
    state.fakeConcedeCount++;
    if (state.fakeConcedeCount >= 3) {
      state.fakeConcedeCount = 0; // 喊過就歸零，避免之後每輪都喊
      return 'CUT'; // 協議洩漏（假讓步家族）第三次
    }
  }

  // 抽象度爬升／句長崩塌：連續三輪都很短、且都沒有實例引用（對聯化前兆）
  if (turns.length >= 3) {
    const tail = turns.slice(-3);
    if (tail.every(t => t.utterance.length < 45 && t.evidenceRefs.length === 0)) {
      return 'CUT';
    }
  }
  return null;
}

/** 每 3 輪：Sonnet 掃繞圈／無限後退／答案已出現／抽象陷阱＋金礦時刻（標記不干涉） */
export async function llmTriggerScan(
  bridgeCall: BridgeCall,
  episodeGoal: string,
  turns: DuoTurn[],
): Promise<{ action: 'CUT' | 'LAND' | 'GROUND' | null; hint: string; gold?: { turnId: number; why: string } } | null> {
  const tail = turns.slice(-6).map(t => `[${t.turnId}｜${t.speaker}]: ${t.utterance}`).join('\n');
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      `這一集對話要回答：「${episodeGoal}」。你檢查最近的對話有沒有四種病＋一種礦：
1. loop：同一組概念在繞圈（第三次出現同樣的對立軸）
2. regress：無限後退——話題一層層往下挖（說服→行動→三個月後→那是不是真的），這條線沒有底
3. answerEmerged：有人已經講出了這一集問題的答案，但他們衝過去繼續挖了——答案出現時你要比他們先認出來
4. abstractTrap：連續的高維概念對撞——原則對原則、定義對定義、比喻對比喻，一路沒有具體的人、事、數字落地。他們講得很嗨，但台下的人已經跟丟了
⭐ gold：金礦時刻——有人說了一句連他自己都停頓了的話、或一段真實的投降（「我不知道」「我沒有底氣」）。金礦不是介入信號，是標記給後製的（不在靈魂最深處的時刻插話）
只輸出純JSON：{"loop":false,"regress":false,"answerEmerged":false,"answer":"","abstractTrap":false,"gold":null 或 {"turnId":數字,"why":"≤15字"}}`,
      tail,
      180,
    );
    const p = extractJson<{ loop?: boolean; regress?: boolean; answerEmerged?: boolean; answer?: string; abstractTrap?: boolean; gold?: { turnId?: number; why?: string } | null }>(raw);
    if (!p) return null;
    const gold = typeof p.gold?.turnId === 'number' && p.gold.why?.trim()
      ? { turnId: p.gold.turnId, why: p.gold.why.trim() }
      : undefined;
    if (p.answerEmerged && p.answer?.trim()) return { action: 'LAND', hint: `答案已經出現：「${p.answer.trim()}」`, gold };
    if (p.loop) return { action: 'CUT', hint: '同一組概念已經繞到第三圈', gold };
    if (p.regress) return { action: 'CUT', hint: '話題在無限後退，一層層往下挖，這條線沒有底，在第二層就要喊停', gold };
    if (p.abstractTrap) return { action: 'GROUND', hint: '他們在高維概念上對撞，聽的人已經跟丟了——拆回具體的人、事、數字', gold };
    return gold ? { action: null, hint: '', gold } : null;
  } catch {
    return null;
  }
}

// ── Producer 發言生成 ─────────────────────────────────────────────────

const ACTION_GUIDE: Record<ProducerAction, string> = {
  CUT: '喊停。把他們剛剛講的用一句話壓縮，然後問「這句話對嗎？」或要求「這一段的結論是什麼？一句話，不要問句。」',
  GROUND: '拉回地面。挑出剛剛出現的漂亮抽象詞，要求拆成具體動作：「拆給我看，三個步驟」「這句話能拿去用嗎，還是只能拿來感動？」',
  AUDIT: '查證。點名剛剛的案例：「這個案例是真的嗎？素材庫裡有嗎？沒有就改成假設一個情境，或者拿掉。」',
  PRESS: '逼問軟肋。點名一直在攻擊卻沒暴露過自己的那一方，把他自己寫的 WEAKEST_POINT 摔到他面前：「你不能繞過去。回答它。」',
  LAND: '收。指出答案已經出現，問雙方要不要停在這裡；不同意的人給一句話版本。',
  ACT_OPEN: '開場指令。宣告這一幕的任務和戰場。',
  REFOCUS: '點名回應。有人開始「說給觀眾聽」而不是「說給對方聽」——但這個節目沒有現場觀眾。重新點名對方回應：叫出另一方的名字，要他接剛剛那句話。對話的張力在兩人之間，不在講台上。',
};

export async function produceUtterance(
  bridgeCall: BridgeCall,
  episodeGoal: string,
  action: ProducerAction,
  context: string,
  turns: DuoTurn[],
  soul?: string | null,
  ammo?: string, // 前製設計的碰撞問題彈藥庫（需要時抽用）
  focus?: string,
): Promise<string> {
  const tail = turns.slice(-5).map(t => `[${t.speaker}]: ${t.utterance}`).join('\n') || '（還沒開始）';
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      producerSystem(episodeGoal, soul, focus),
      `最近的對話：\n${tail}\n\n你現在要做的動作：${action} — ${ACTION_GUIDE[action]}\n${context ? `背景：${context}\n` : ''}${ammo ? `你前製設計的碰撞問題（彈藥庫，這個動作用得上就抽一題、用你的話問；用不上就不用）：\n${ammo}\n` : ''}\n直接說你要說的話（不加名字標記、不加說明），三句以內，短、硬、具體。`,
      200,
    );
    return raw.trim().replace(/^\[.*?\][:：]\s*/, '');
  } catch {
    return ''; // Producer 掛了不擋角色說話；交付物驗收會抓到缺口
  }
}

// ── 分歧宣言（Act 1 出口）──────────────────────────────────────────────

export async function distillDisagreement(
  bridgeCall: BridgeCall,
  episodeGoal: string,
  turns: DuoTurn[],
  chars: DuoChar[],
  beliefs: Map<string, BeliefState>,
  soul?: string | null,
  focus?: string,
): Promise<string> {
  const transcript = turns.map(t => `[${t.speaker}]: ${t.utterance}`).join('\n');
  const claims = chars.map(c => `${c.name}：${beliefs.get(c.id)?.coreClaim ?? ''}`).join('\n');
  const raw = await bridgeCall(
    DUO_MODEL,
    producerSystem(episodeGoal, soul, focus),
    `雙方核心主張：\n${claims}\n\n第一幕逐字稿：\n${transcript}\n\n把他們的分歧壓縮成一句話（≤40字），格式「他們的分歧是：______」。只輸出這一句。`,
    100,
  );
  return raw.trim().replace(/^他們的分歧是[:：]?\s*/, '');
}

/** 角色是否同意這句分歧宣言（輕確認，一人一問） */
export async function confirmDisagreement(
  bridgeCall: BridgeCall,
  char: DuoChar,
  statement: string,
): Promise<boolean> {
  try {
    const raw = await bridgeCall(
      DUO_MODEL,
      `你是${char.name}。製作人說你們兩人的分歧是：「${statement}」。這抓得準嗎？只輸出純JSON：{"agree":true} 或 {"agree":false}`,
      '確認。',
      30,
    );
    const p = extractJson<{ agree?: boolean }>(raw);
    return p?.agree !== false; // 解析不出來當同意（fail-open，Producer 有裁定權）
  } catch {
    return true;
  }
}

// ── EpisodeMeta（Act 3 交付物）─────────────────────────────────────────

export async function generateEpisodeMeta(
  bridgeCall: BridgeCall,
  episodeGoal: string,
  disagreementStatement: string,
  turns: DuoTurn[],
  deltas: BeliefDeltaRecord[],
  soul?: string | null,
  focus?: string,
): Promise<Omit<EpisodeMeta, 'episodeGoal' | 'disagreementStatement' | 'beliefDeltas'>> {
  const transcript = turns.map(t => `[${t.speaker}]: ${t.utterance}`).join('\n');
  const system = producerSystem(episodeGoal, soul, focus) + `

現在全場結束，你要交出這一集的交付物。誠實保留的分歧比假共識值錢——聽眾要的正是兩個專業的人究竟在哪裡真的分開了。takeaway 要是聽眾帶得走的，動詞開頭。`;
  const user = `分歧宣言：${disagreementStatement}
立場位移紀錄：${deltas.length ? deltas.map(d => `${d.speaker} 第${d.turnId}輪：${d.delta}`).join('；') : '（整場沒有人移動——誠實記錄）'}

全場逐字稿：
${transcript}

輸出純JSON（不加markdown）：
{"consensus":["共識一，一句話","共識二，一句話"],"preservedDisagreement":"他們談不攏的一點＋為什麼談不攏","takeaways":["動詞開頭","動詞開頭","動詞開頭"]}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await bridgeCall(DUO_MODEL, system, user, 500);
    const p = extractJson<{ consensus?: string[]; preservedDisagreement?: string; takeaways?: string[] }>(raw);
    if (p && Array.isArray(p.consensus) && p.consensus.filter(s => s?.trim()).length >= 2
      && p.preservedDisagreement?.trim()
      && Array.isArray(p.takeaways) && p.takeaways.filter(s => s?.trim()).length >= 3) {
      return {
        consensus: p.consensus.filter(s => s?.trim()).slice(0, 2),
        preservedDisagreement: p.preservedDisagreement.trim(),
        takeaways: p.takeaways.filter(s => s?.trim()).slice(0, 3),
      };
    }
    console.warn(`[duo] episodeMeta 第 ${attempt + 1} 次生成不合格，重生成`);
  }
  throw new Error('交付物生成失敗（3 次）：這集不算完成');
}
