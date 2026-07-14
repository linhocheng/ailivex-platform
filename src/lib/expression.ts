/**
 * 表達層 —— soul 的外掛：慣用語、口頭禪、特定情境的說法。
 *
 * 與 soul 分離：soul 是人格本文（他是誰），表達層是說話的樣子（他怎麼說），可動態演化而不動人格。
 * 與 memories 的本質差別：無條件全文注入，不走檢索、不衰減、對所有用戶一致。
 *
 * 動態通道：admin 對話中角色發 [[EXPRESSION]] 標記 → dialogue route 閘門（僅 admin 寫入）；
 * 後台 characters 編輯頁可增刪改。語音路徑（function tool）二期。
 */

export const EXPRESSION_MAX = 20;

export function buildExpressionBlock(expression?: string[]): string {
  const items = (expression ?? []).map(s => s.trim()).filter(Boolean);
  if (items.length === 0) return '';
  return `\n\n【你的表達習慣】
${items.map(s => `- ${s}`).join('\n')}
這些是你自然的說話方式，內化著用，不要逐條背誦、不要刻意展示。`;
}

// 只在 admin（訓練師）對話時注入——一般用戶對話不帶這段，角色就不會受用戶指揮改嘴。
export const EXPRESSION_INSTRUCTION = `
- 當對方（你的訓練師）調整你的說話方式、慣用語、或特定情境該怎麼說（例如「這種時候你通常會說……」），在回覆中夾帶：
  [[EXPRESSION]] 用第一人稱記下這個表達習慣（例：遇到OO情境時，我慣說「xxx」）[[/EXPRESSION]]
  這段不會顯示給對方，會成為你今後對所有人的說話習慣。只在對方明確調整你的表達方式時使用，一般聊天不發。`;
