/**
 * LLM 輸出一律當「不可信文字」：先確定性 parse，壞了用確定性 repair —— 不 re-ask 模型修 JSON。
 *
 * 天條：拿 LLM 去補 LLM 的壞輸出，還是把計算丟給機率引擎。
 * repair 只做機械式、可逆、不改語義的修補（剝 markdown 圍欄、彎引號→直、去尾逗號）。
 */
export function parseJsonLoose<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  for (const candidate of [raw, repair(raw)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* 試下一個 */
    }
  }
  return null;
}

function repair(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')   // 開頭 markdown 圍欄
    .replace(/\s*```\s*$/i, '')             // 結尾圍欄
    .replace(/[\u201c\u201d]/g, '"')        // 彎雙引號 “ ” → "
    .replace(/[\u2018\u2019]/g, "'")        // 彎單引號 ‘ ’ → '
    .replace(/,\s*([}\]])/g, '$1')          // 物件/陣列尾端多餘逗號
    .trim();
}
