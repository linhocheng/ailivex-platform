/**
 * 瘦版對話 —— ailiveX 核心。綁 (用戶 × 角色)。
 *
 * 流程：auth + access → 載 soul + 該用戶記憶 + 歷史 → bridge LLM
 *      → 程式 parse 工具標記（remember / document）→ 回覆 + 存對話 + 寫記憶。
 *
 * 角色不共享記憶：memory / conversation 都嚴格綁 (userId, characterId)。
 * bridge 不支援 tool_use → 工具走文字標記 + 確定性 parse（見 tool-tags.ts）。
 */
import { after } from 'next/server';
import { NextResponse } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';
import { hasAccess } from '@/lib/access';
import { COL, type CharacterDoc, type ChatMessage } from '@/lib/collections';
import { loadConversationContext, appendMessages } from '@/lib/conversation';
import { loadMemoryBlock, writeMemory, extractAndSaveMemories } from '@/lib/memory';
import { loadDiaryBlock, writeDiaryEntry } from '@/lib/diary';
import { loadKnowledgeBlock, saveKnowledgeProposal, KNOWLEDGE_PROPOSE_INSTRUCTION } from '@/lib/knowledge';
import { loadMethodologyBlock, applyMethodologySignals, saveMethodologyProposal, loadActiveMethodologies, buildMethodInventoryNote, METHOD_PROPOSE_INSTRUCTION } from '@/lib/methodology';
import { parseToolTags, TOOL_INSTRUCTIONS } from '@/lib/tool-tags';
import { buildExpressionBlock, EXPRESSION_INSTRUCTION, EXPRESSION_MAX } from '@/lib/expression';
import { createDocumentJob, dispatchDocumentJob } from '@/lib/documents';
import { QuotaExceededError, consumeTextQuota, refundTextQuota } from '@/lib/quota';
import { dispatchTask } from '@/lib/task-dispatcher';
import { upsertRelationship } from '@/lib/relationship';
import { trackCost } from '@/lib/cost-tracker';
import { readUrlsForContext } from '@/lib/url-reader';
import { recordOpsEvent } from '@/lib/ops-event';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MODEL = 'claude-sonnet-4-6';

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter(c => c.type === 'text')
    .map(c => (c as Anthropic.TextBlock).text)
    .join('');
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null) as { characterId?: string; message?: string } | null;
  const characterId = body?.characterId?.trim();
  const message = body?.message?.trim();
  if (!characterId || !message) {
    return NextResponse.json({ error: 'characterId 與 message 必填' }, { status: 400 });
  }

  const db = getFirestore();

  // 後端把關：沒被指派就擋（不靠前端隱藏）
  if (user.role !== 'admin' && !(await hasAccess(db, user.uid, characterId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const charSnap = await db.collection(COL.characters).doc(characterId).get();
  if (!charSnap.exists) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  const char = charSnap.data() as CharacterDoc;

  // 文字對話計量：每則 user 訊息扣 1；額度滿誠實告知（不進 LLM、不寫歷史）
  let textRemaining: number | null = null;
  try {
    textRemaining = await consumeTextQuota(db, user.uid);
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return NextResponse.json({
        reply: '（您的文字對話額度已用罄，如需增購請聯繫您的服務窗口。）',
        documents: [],
        quotaExhausted: 'text',
        textRemaining: 0,
      });
    }
    throw e;
  }

  const soul = char.soul || '';
  // 方法論要先知道 conversation 的進行中狀態 → 接在 conv 讀之後（其餘全並行）。
  // 知識庫/方法論：角色沒設定（count 缺省/0）時兩條路徑直接空手，行為與既有完全一致。
  const convCtxPromise = loadConversationContext(db, user.uid, characterId);
  const [memoryBlock, diaryBlock, convCtx, linkContext, knowledgeBlock, methodologyRes] = await Promise.all([
    loadMemoryBlock(db, user.uid, characterId, message),
    loadDiaryBlock(db, user.uid, characterId),
    convCtxPromise,
    // 連結閱讀：用戶訊息有 URL → 抓網頁正文，附到這一輪的 context（歷史只存原訊息，不存正文）
    readUrlsForContext(message),
    loadKnowledgeBlock(db, characterId, message, char),
    convCtxPromise.then(ctx =>
      loadMethodologyBlock(db, characterId, message, ctx.activeMethodology, char)),
  ]);
  const history = convCtx.history;

  // 表達層：緊貼 soul 無條件注入；[[EXPRESSION]] 教學指令只給 admin（訓練師）對話，一般用戶不帶
  // 方法論/知識共創指令：admin 對所有角色恆有（2026-07-19 起 per-character 旗標退役）
  // 共創語境附現有方法論清單——沒有清單訓練師問「你有哪些」角色只能誠實說沒有（2026-07-19 實測）
  const expressionBlock = buildExpressionBlock(char.expression);
  let proposeInstruction = '';
  if (user.role === 'admin') {
    const inventory = await loadActiveMethodologies(db, characterId).catch(() => []);
    proposeInstruction = METHOD_PROPOSE_INSTRUCTION + buildMethodInventoryNote(inventory)
      + KNOWLEDGE_PROPOSE_INSTRUCTION;
  }
  const toolInstructions = user.role === 'admin'
    ? TOOL_INSTRUCTIONS + EXPRESSION_INSTRUCTION + proposeInstruction
    : TOOL_INSTRUCTIONS;
  const system = `${soul}${expressionBlock}${memoryBlock}${diaryBlock}${knowledgeBlock}${methodologyRes.block}${toolInstructions}

你正在跟「${user.name}」對話。用你的靈魂，自然地回應。${linkContext ? `

若訊息後附了【用戶分享的連結內容】，那是對方貼的連結正文，自然讀完、用你的角度回應，別逐字複述；若是【連結讀取失敗】就坦白說你打不開。` : ''}`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
    { role: 'user', content: message + linkContext },
  ];

  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 110_000 });
  const llmStarted = Date.now();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages,
  }).catch(async e => {
    await refundTextQuota(db, user.uid); // LLM 失敗不吃額度
    recordOpsEvent({
      kind: 'dialogue', status: 'fail', userId: user.uid, characterId,
      latencyMs: Date.now() - llmStarted, error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  });

  const raw = textOf(res);
  const parsed = parseToolTags(raw);
  const { visible, remembers, documents, dispatches } = parsed;
  let reply = visible || '（……）';

  // 方法論狀態推進（確定性，影響下一輪；沒設方法論的角色一律跳過）
  if ((char.methodologyCount ?? 0) > 0) {
    await applyMethodologySignals(
      db, user.uid, characterId,
      { methodStart: parsed.methodStart, methodNext: parsed.methodNext, methodExit: parsed.methodExit },
      convCtx.activeMethodology, methodologyRes.active,
    );
  }

  // 表達層寫入：僅 admin（訓練師）對話生效；上限硬閘，滿了誠實告知不硬塞
  if (user.role === 'admin' && parsed.expressions.length > 0) {
    const existing = (char.expression ?? []).map(s => s.trim()).filter(Boolean);
    const fresh = parsed.expressions.filter(s => !existing.includes(s));
    const room = Math.max(0, EXPRESSION_MAX - existing.length);
    const toAdd = fresh.slice(0, room);
    if (toAdd.length > 0) {
      await db.collection(COL.characters).doc(characterId).update({ expression: [...existing, ...toAdd] })
        .catch(e => console.error('[dialogue] expression write failed:', e instanceof Error ? e.message : String(e)));
    }
    if (fresh.length > toAdd.length) {
      reply += `\n\n（表達層已達 ${EXPRESSION_MAX} 條上限，本次有 ${fresh.length - toAdd.length} 條未寫入；請先到後台整理再教。）`;
    }
  }

  // 方法論提案：admin 限定（非 admin → 標記已被 parse 剝掉，不落任何庫）。
  // 落 draft 不動 methodologyCount；成敗都在回覆裡誠實告知訓練師，不靜默蒸發。
  if (user.role === 'admin' && parsed.methodProposals.length > 0) {
    for (const rawProposal of parsed.methodProposals) {
      const r = await saveMethodologyProposal(db, characterId, rawProposal, user.uid)
        .catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      reply += r.ok
        ? `\n\n（方法論提案《${r.name}》已收進待審區——到後台「知識與方法」審核轉正後，才對所有用戶生效。）`
        : `\n\n（方法論提案未能收下：${r.error}。可請角色修正後重新提出。）`;
    }
  }

  // 知識提案：同一道 admin 閘；draft 不入庫（角色會幻覺——審核通過才走 ingest 正式管線）
  if (user.role === 'admin' && parsed.knowledgeProposals.length > 0) {
    for (const kp of parsed.knowledgeProposals) {
      const r = await saveKnowledgeProposal(db, characterId, kp.title, kp.content, user.uid, '文字共創對話')
        .catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      reply += r.ok
        ? `\n\n（知識提案《${r.title}》已收進待審區——到後台「知識與方法」審核轉入庫後，才成為角色知識。）`
        : `\n\n（知識提案未能收下：${r.error}。）`;
    }
  }

  // 工具副作用（不阻斷回覆）
  for (const content of remembers) {
    await writeMemory(db, user.uid, characterId, content, { source: 'tool:remember', importance: 6 })
      .catch(e => console.error('[dialogue] remember failed:', e instanceof Error ? e.message : String(e)));
  }
  const createdDocs: Array<{ documentId: string; title: string }> = [];
  const pendingJobIds: string[] = [];
  let docQuotaHit = false;
  for (const d of documents) {
    const r = await createDocumentJob(db, user.uid, characterId, d.title, d.brief)
      .catch(e => {
        if (e instanceof QuotaExceededError) { docQuotaHit = true; return null; }
        console.error('[dialogue] document failed:', e instanceof Error ? e.message : String(e));
        return null;
      });
    if (r) {
      createdDocs.push({ documentId: r.documentId, title: d.title });
      pendingJobIds.push(r.jobId);
    }
  }
  // 角色答應了但額度不夠 → 誠實告知，不能讓「說要生成」變成空頭支票
  if (docQuotaHit) {
    reply += '\n\n（文件產出額度已用罄，本次未建立文件。如需增購請聯繫您的服務窗口。）';
  }

  // dispatches 移到 after() — enqueueStoryDraftJob 需要 await fetch，在 after() 裡才保證 lambda 存活
  const capabilities = char.capabilities ?? [];
  const voiceId = char.voiceIdMinimax ?? '';
  const pendingDispatches = dispatches
    .filter(d => capabilities.includes(d.type))
    .map(d => ({
      ...d,
      params: d.type === 'script_draft' ? { ...d.params, voiceId } : d.params,
    }));

  // 存對話
  const now = Date.now();
  const userMsg: ChatMessage = { role: 'user', content: message, at: now };
  const botMsg: ChatMessage = { role: 'assistant', content: reply, at: now + 1 };
  await appendMessages(db, user.uid, characterId, [userMsg, botMsg]);

  // 異步提煉記憶 + dispatch 文件任務（回覆送出後跑，確保 Vercel lambda 不被凍結前遺漏）
  const charName = char.name;
  const recentMessages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
    { role: 'assistant' as const, content: reply },
  ];
  after(async () => {
    // 每個副作用獨立 catch：吞可以，吞之前留痕；一個失敗不連坐其他（原 Promise.all 一 reject 全滅）
    const swallow = (sideEffect: string) => (e: unknown) => {
      console.error(`[dialogue] ${sideEffect} failed:`, e instanceof Error ? e.message : String(e));
      recordOpsEvent({ kind: 'side_effect_error', status: 'fail', sideEffect, userId: user.uid, characterId, error: e instanceof Error ? e.message : String(e) });
    };
    const extractClient = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '');
    await Promise.all([
      extractAndSaveMemories(db, user.uid, characterId, charName, recentMessages, extractClient).catch(swallow('memory_extract')),
      writeDiaryEntry(db, user.uid, characterId, charName, soul, user.name, recentMessages, extractClient, 'text').catch(swallow('diary')),
      upsertRelationship(db, user.uid, characterId).catch(swallow('relationship')),
    ]);
    await Promise.all(pendingJobIds.map(id => dispatchDocumentJob(id).catch(swallow('doc_dispatch'))));
    // dispatchTask 在 after() 裡執行，確保 lambda 存活到 HTTP 請求送出
    for (const d of pendingDispatches) {
      await dispatchTask(user.uid, characterId, d.type, d.intent, d.params)
        .catch(swallow('task_dispatch'));
    }
  });

  // 費用
  void trackCost(
    characterId, MODEL,
    res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0,
    'dialogue', user.uid,
  );
  // 監控事件：這一回合成功（延遲=LLM 往返）
  recordOpsEvent({ kind: 'dialogue', status: 'ok', userId: user.uid, characterId, latencyMs: Date.now() - llmStarted });

  return NextResponse.json({ reply, documents: createdDocs, textRemaining });
}
