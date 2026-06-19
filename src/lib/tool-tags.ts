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
  documents: Array<{ title: string; brief: string }>;
  dispatches: DispatchCall[];
}

const REMEMBER_RE = /\[\[REMEMBER\]\]([\s\S]*?)\[\[\/REMEMBER\]\]/g;
const DOCUMENT_RE = /\[\[DOCUMENT(?:\s+title="([^"]*)")?\]\]([\s\S]*?)\[\[\/DOCUMENT\]\]/g;
const DISPATCH_RE = /\[\[DISPATCH(?:\s+([^[\]]*))?\]\][\s\S]*?\[\[\/DISPATCH\]\]/g;

// 同時支援雙引號與單引號值 —— params 的 JSON 內含雙引號，文件格式用單引號包覆。
function parseAttrs(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) result[m[1]] = m[2] ?? m[3] ?? '';
  return result;
}

const VALID_CAPABILITIES: TaskCapability[] = ['image_generation', 'audio_generation', 'writing', 'web_search'];

export function parseToolTags(raw: string): ParsedTools {
  const remembers: string[] = [];
  const documents: Array<{ title: string; brief: string }> = [];
  const dispatches: DispatchCall[] = [];

  let m: RegExpExecArray | null;

  REMEMBER_RE.lastIndex = 0;
  while ((m = REMEMBER_RE.exec(raw)) !== null) {
    const c = m[1].trim();
    if (c) remembers.push(c);
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

  const visible = raw
    .replace(REMEMBER_RE, '')
    .replace(DOCUMENT_RE, '')
    .replace(DISPATCH_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { visible, remembers, documents, dispatches };
}

export const TOOL_INSTRUCTIONS = `

【你的能力】
- 當這個人說了值得長期記住的事（偏好、重要經歷、關係、決定），在回覆中夾帶：
  [[REMEMBER]] 用第一人稱簡短記下你要記住的事 [[/REMEMBER]]
  這段不會顯示給對方，只進你對這個人的記憶。不要每句都記，只記真正重要的。
- 當對方請你寫一份策略書、企劃書或正式文件，在回覆中夾帶：
  [[DOCUMENT title="文件標題"]] 文件的主題、結構與重點要求 [[/DOCUMENT]]
  系統會非同步幫你產出文件，對方會在「我的文件」看到。你只需在標記裡寫清楚要求，並口頭告訴對方「我這就幫你寫，稍後到文件區看」。
- 當你被授權派發任務（如生圖、生音檔），在回覆中夾帶：
  [[DISPATCH type="image_generation" intent="用一句話描述任務" params='{"prompt":"具體提示詞"}']][[/DISPATCH]]
  type 可以是：image_generation / audio_generation / writing / web_search。
  這段不會顯示給對方，系統背景執行。你只需口頭說「我已安排，完成後會告訴你」。
標記以外的文字才是你對這個人說的話。`;
