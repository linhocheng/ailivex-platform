/**
 * 簡→繁機制級轉換。
 *
 * LLM / STT 產出的中文在入庫、渲染前一律過這層——確定性程式保證，
 * 不靠 prompt 拜託模型輸出繁體（天條：確定性的工作用程式）。
 *
 * 用字元級 s2tw 不用 s2twp：twp 的台灣用語詞組會改寫已是繁體的正確文本
 * （文件→檔案），且兩者都把「发文」誤斷成「編髮」的髮——先用覆寫表釘死再轉。
 */
import * as OpenCC from 'opencc-js';

const convert = OpenCC.Converter({ from: 'cn', to: 'tw' });

// OpenCC 詞典誤斷的確定性覆寫（轉換前先套用，長詞優先）
const OVERRIDES: Array<[string, string]> = [
  ['发文', '發文'], // 编发文→編「髮」文 誤斷
];

export function toTraditional(text: string): string {
  if (!text) return text;
  try {
    let t = text;
    for (const [from, to] of OVERRIDES) t = t.split(from).join(to);
    return convert(t);
  } catch {
    return text; // 轉換異常不擋主流程，原文放行
  }
}
