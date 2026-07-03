/**
 * TTS 文字正規化：繁→簡之後、送 MiniMax 之前的確定性處理
 * 所有修正都是程式級 Map/regex，不走 LLM
 */
import * as OpenCC from 'opencc-js';

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

const DIGIT_ZH: Record<string, string> = {
  '0': '〇', '1': '一', '2': '二', '3': '三', '4': '四',
  '5': '五', '6': '六', '7': '七', '8': '八', '9': '九',
};

function digitToZh(n: string): string {
  return n.split('').map(d => DIGIT_ZH[d] ?? d).join('');
}

// MiniMax 會把 1999 唸成「一千九百九十九」，改成逐字中文「一九九九」
function convertYears(text: string): string {
  return text.replace(/([12]\d{3})(年[代間份初末底前後]?)/g, (_, year, suffix) =>
    `${digitToZh(year)}${suffix}`
  );
}

// key = 簡體中文詞（opencc 轉換後的形式）；value = 替換目標
const NORMALIZE_RULES: Array<[RegExp | string, string]> = [
  ['垃圾',  '废弃物'],   // 台灣唸 lèsè，MiniMax 唸 lājī
  ['晶片',  '芯片'],     // opencc 後仍是「晶片」，MiniMax 更熟「芯片」
  ['软体',  '软件'],     // opencc 把「軟體」→「软体」，MiniMax 更熟「软件」
  ['硬体',  '硬件'],     // opencc 把「硬體」→「硬体」，MiniMax 更熟「硬件」
  ['网路',  '网络'],     // opencc 把「網路」→「网路」，MiniMax 更熟「网络」
];

// opencc 轉換，保護 MiniMax 標記不被誤轉
function convertToSimplified(text: string): string {
  const placeholders: string[] = [];
  const masked = text.replace(/(\([a-z-]+\)|<#[\d.]+#>)/g, (m) => {
    placeholders.push(m);
    return `\x00${placeholders.length - 1}\x00`;
  });
  const converted = toSimplified(masked);
  return converted.replace(/\x00(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
}

function applyNormalizeRules(text: string): string {
  let result = text;
  for (const [pattern, replacement] of NORMALIZE_RULES) {
    if (typeof pattern === 'string') {
      result = result.split(pattern).join(replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

// 1. 年份數字 → 中文（繁體階段）
// 2. 繁→簡（保護標記）
// 3. 破音字表（簡體字上套用）
export function normalizeTTSText(text: string): string {
  return applyNormalizeRules(convertToSimplified(convertYears(text)));
}
