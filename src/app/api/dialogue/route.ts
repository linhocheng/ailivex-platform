/**
 * 瘦版對話 —— ailiveX 核心。綁 (用戶 × 角色)。
 *
 * 流程：auth + access → 載 soulCore + 該用戶記憶 + 歷史 → bridge LLM
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
import { loadHistory, appendMessages } from '@/lib/conversation';
import { loadMemoryBlock, writeMemory, extractAndSaveMemories } from '@/lib/memory';
import { parseToolTags, TOOL_INSTRUCTIONS } from '@/lib/tool-tags';
import { createDocumentJob, dispatchDocumentJob } from '@/lib/documents';
import { dispatchTask } from '@/lib/task-dispatcher';
import { upsertRelationship } from '@/lib/relationship';
import { trackCost } from '@/lib/cost-tracker';
import { readUrlsForContext } from '@/lib/url-reader';

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

  // 靈魂優先序：soulCore → soul
  const soul = (char.soulCore && char.soulCore.trim()) || char.soul || '';
  const memoryBlock = await loadMemoryBlock(db, user.uid, characterId, message);
  const history = await loadHistory(db, user.uid, characterId);

  // 連結閱讀：用戶訊息有 URL → 抓網頁正文，附到這一輪的 context（歷史只存原訊息，不存正文）
  const linkContext = await readUrlsForContext(message);

  const system = `${soul}${memoryBlock}${TOOL_INSTRUCTIONS}

你正在跟「${user.name}」對話。用你的靈魂，自然地回應。${linkContext ? `

若訊息後附了【用戶分享的連結內容】，那是對方貼的連結正文，自然讀完、用你的角度回應，別逐字複述；若是【連結讀取失敗】就坦白說你打不開。` : ''}`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
    { role: 'user', content: message + linkContext },
  ];

  const client = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '', { bridgeTimeoutMs: 110_000 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages,
  });

  const raw = textOf(res);
  const { visible, remembers, documents, dispatches } = parseToolTags(raw);
  const reply = visible || '（……）';

  // 工具副作用（不阻斷回覆）
  for (const content of remembers) {
    await writeMemory(db, user.uid, characterId, content, { source: 'tool:remember', importance: 6 })
      .catch(e => console.error('[dialogue] remember failed:', e instanceof Error ? e.message : String(e)));
  }
  const createdDocs: Array<{ documentId: string; title: string }> = [];
  const pendingJobIds: string[] = [];
  for (const d of documents) {
    const r = await createDocumentJob(db, user.uid, characterId, d.title, d.brief)
      .catch(e => { console.error('[dialogue] document failed:', e instanceof Error ? e.message : String(e)); return null; });
    if (r) {
      createdDocs.push({ documentId: r.documentId, title: d.title });
      pendingJobIds.push(r.jobId);
    }
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
    const extractClient = getAnthropicClient(process.env.ANTHROPIC_API_KEY || '');
    await Promise.all([
      extractAndSaveMemories(db, user.uid, characterId, charName, recentMessages, extractClient),
      upsertRelationship(db, user.uid, characterId),
    ]);
    await Promise.all(pendingJobIds.map(id => dispatchDocumentJob(id)));
    // dispatchTask 在 after() 裡執行，確保 lambda 存活到 HTTP 請求送出
    for (const d of pendingDispatches) {
      await dispatchTask(user.uid, characterId, d.type, d.intent, d.params)
        .catch(e => console.error('[dialogue] dispatch failed:', e instanceof Error ? e.message : String(e)));
    }
  });

  // 費用
  void trackCost(
    characterId, MODEL,
    res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0,
    'dialogue', user.uid,
  );

  return NextResponse.json({ reply, documents: createdDocs });
}
