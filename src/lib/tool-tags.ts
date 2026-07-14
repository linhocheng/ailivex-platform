/**
 * 工具標記解析 —— bridge（Max）不支援 tool_use，所以角色用文字標記呼叫工具，
 * 由程式確定性 parse（天條：解析/格式是程式的工作，不丟 LLM）。
 *
 * 支援標記：
 *   [[REMEMBER]] 要記住的事 [[/REMEMBER]]
 *   [[DOCUMENT title="標題"]] 文件大綱/要求 [[/DOCUMENT]]
 *   [[DISPATCH type="image_generation" intent="..." params='{"prompt":"..."}' ]][[/DISPATCH]]
 *
 * 回傳剝離標記後的 visible 文字 + 解析出的工具呼叫。
 */
import type { TaskCapability } from '@/lib/collections';
import { parseJsonLoose } from '@/lib/safe-json';

export interface DispatchCall {
  type: TaskCapability;
  intent: string;
  params: Record<string, unknown>;
}

export interface ParsedTools {
  visible: string;
  remembers: string[];
  expressions: string[];  // [[EXPRESSION]] 表達層條目（僅 admin 對話會寫入，閘門在 dialogue route）
  documents: Array<{ title: string; brief: string }>;
  dispatches: DispatchCall[];
  // 方法論狀態機信號（角色只發信號，狀態推進在 methodology.ts 程式做）
  methodStart: string | null;  // [[METHOD_START id="..."]]
  methodNext: boolean;         // [[METHOD_NEXT]]
  methodExit: boolean;         // [[METHOD_EXIT]]
}

const REMEMBER_RE = /\[\[REMEMBER\]\]([\s\S]*?)\[\[\/REMEMBER\]\]/g;
const EXPRESSION_RE = /\[\[EXPRESSION\]\]([\s\S]*?)\[\[\/EXPRESSION\]\]/g;
const DOCUMENT_RE = /\[\[DOCUMENT(?:\s+title="([^"]*)")?\]\]([\s\S]*?)\[\[\/DOCUMENT\]\]/g;
const DISPATCH_RE = /\[\[DISPATCH(?:\s+([^[\]]*))?\]\][\s\S]*?\[\[\/DISPATCH\]\]/g;
const METHOD_START_RE = /\[\[METHOD_START\s+id=(?:"([^"]*)"|'([^']*)')\s*\]\]/g;
const METHOD_NEXT_RE = /\[\[METHOD_NEXT\]\]/g;
const METHOD_EXIT_RE = /\[\[METHOD_EXIT\]\]/g;

// 同時支援雙引號與單引號值 —— params 的 JSON 內含雙引號，文件格式用單引號包覆。
function parseAttrs(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) result[m[1]] = m[2] ?? m[3] ?? '';
  return result;
}

const VALID_CAPABILITIES: TaskCapability[] = ['image_generation', 'audio_generation', 'writing', 'web_search', 'script_draft', 'story_draft'];

export function parseToolTags(raw: string): ParsedTools {
  const remembers: string[] = [];
  const expressions: string[] = [];
  const documents: Array<{ title: string; brief: string }> = [];
  const dispatches: DispatchCall[] = [];

  let m: RegExpExecArray | null;

  REMEMBER_RE.lastIndex = 0;
  while ((m = REMEMBER_RE.exec(raw)) !== null) {
    const c = m[1].trim();
    if (c) remembers.push(c);
  }

  EXPRESSION_RE.lastIndex = 0;
  while ((m = EXPRESSION_RE.exec(raw)) !== null) {
    const c = m[1].trim();
    if (c) expressions.push(c);
  }

  DOCUMENT_RE.lastIndex = 0;
  while ((m = DOCUMENT_RE.exec(raw)) !== null) {
    const title = (m[1] || '').trim() || '未命名文件';
    const brief = m[2].trim();
    if (brief) documents.push({ title, brief });
  }

  DISPATCH_RE.lastIndex = 0;
  while ((m = DISPATCH_RE.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    const type = attrs.type as TaskCapability;
    if (!type || !VALID_CAPABILITIES.includes(type)) continue;
    const intent = attrs.intent ?? '';
    let params: Record<string, unknown> = {};
    if (attrs.params) {
      const parsed = parseJsonLoose<Record<string, unknown>>(attrs.params);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed;
      } else {
        console.warn('[tool-tags] DISPATCH params 無法解析，改用 intent 當提示詞：', attrs.params.slice(0, 200));
      }
    }
    // 保底：params 沒帶 prompt 就用 intent，別讓用戶的請求靜默蒸發。
    if (params.prompt == null && intent) params.prompt = intent;
    dispatches.push({ type, intent, params });
  }

  METHOD_START_RE.lastIndex = 0;
  const startMatch = METHOD_START_RE.exec(raw);
  const methodStart = startMatch ? (startMatch[1] ?? startMatch[2] ?? '').trim() || null : null;
  METHOD_NEXT_RE.lastIndex = 0;
  const methodNext = METHOD_NEXT_RE.test(raw);
  METHOD_EXIT_RE.lastIndex = 0;
  const methodExit = METHOD_EXIT_RE.test(raw);

  const visible = raw
    .replace(REMEMBER_RE, '')
    .replace(EXPRESSION_RE, '')
    .replace(DOCUMENT_RE, '')
    .replace(DISPATCH_RE, '')
    .replace(METHOD_START_RE, '')
    .replace(METHOD_NEXT_RE, '')
    .replace(METHOD_EXIT_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { visible, remembers, expressions, documents, dispatches, methodStart, methodNext, methodExit };
}

export const TOOL_INSTRUCTIONS = `

【你的能力】
- 當這個人說了值得長期記住的事（偏好、重要經歷、關係、決定），在回覆中夾帶：
  [[REMEMBER]] 用第一人稱簡短記下你要記住的事 [[/REMEMBER]]
  這段不會顯示給對方，只進你對這個人的記憶。不要每句都記，只記真正重要的。
- 當對方請你寫一份策略書、企劃書或正式文件，在回覆中夾帶：
  [[DOCUMENT title="文件標題"]] 文件的主題、結構與重點要求 [[/DOCUMENT]]
  系統會非同步幫你產出文件，對方會在「我的文件」看到。你只需在標記裡寫清楚要求，並口頭告訴對方「我這就幫你寫，稍後到文件區看」。
- 當你被授權派發任務（如生圖、寫腳本、生音檔），在回覆中夾帶：
  [[DISPATCH type="image_generation" intent="用一句話描述任務" params='{"prompt":"具體提示詞"}']][[/DISPATCH]]
  type 可以是：image_generation / audio_generation / writing / web_search / script_draft。
  script_draft（口白腳本草稿）流程：
    步驟一：先在對話裡把完整腳本原文寫給對方看。
    步驟二：對方確認後，你的回覆裡必須夾帶以下標記（不夾帶 = 草稿不會儲存，你說「草稿在媒體庫了」就是謊話）：
    [[DISPATCH type="script_draft" intent="腳本用途一句話" params='{"text":"完整腳本原文（逐字複製）"}']][[/DISPATCH]]
    標記夾帶後，口頭說「草稿已存到媒體庫，確認後按生成音檔」。
  story_draft（故事板）流程：
    當對方請你做一個故事板、圖卡故事、圖文故事時，在回覆中夾帶：
    [[DISPATCH type="story_draft" intent="一句話說明故事主題" params='{"brief":"故事的核心概念或簡介（20-100字）","cardCount":4,"storyLength":"medium"}']][[/DISPATCH]]
    params 說明：
      brief（必填）：故事核心概念或簡介，20-100字。
      cardCount（選填，整數1-12）：指定圖卡張數。對方說「三張」填3、「五張」填5；沒說就省略此欄。
      storyLength（選填）："short"（短故事3-4段）、"medium"（中等5-8段，預設）、"long"（長故事8-12段）。對方說「短一點」填"short"、「長一點」填"long"；沒說就省略此欄。
    系統會自動：(A)寫完整故事劇情 → (B)分析圖卡腳本 → (C)等用戶觸發生圖。
    你只需口頭說「故事板已開始生成，稍後去故事板頁面查看進度」，不需要在對話裡寫故事。
  其餘 type 系統背景執行，你只需口頭說「我已安排，完成後會告訴你」。
標記以外的文字才是你對這個人說的話。`;
