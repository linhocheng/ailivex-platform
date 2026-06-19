/**
 * 邊界正規化 —— env / header 值跨系統時會被編碼污染：
 *   - `vercel env pull` 把真換行(char10)寫成字面 "\n"（反斜線+n）
 *   - shell / Secret Manager 注入留尾端空白或真換行
 *   - 有人手動加了包覆引號
 * 確定性的密鑰 / URL 比對不能靠肉眼或運氣對上 —— 在每個生產端與消費端
 * 都過同一個清洗函式（咽喉防禦），byte-identical 由程式保證，不是巧合。
 *
 * 天條：確定性的事用程式保證 100%，驗證也用程式（byte 級），不是用看的。
 */

// 密鑰：剝包覆引號、字面跳脫序列、所有空白。兩端都套後比對必然一致。
export function cleanSecret(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/^["']|["']$/g, '')   // 包住的引號
    .replace(/\\[nrt]/g, '')        // 字面 \n \r \t（反斜線+字母）
    .replace(/\s+/g, '');           // 任何真空白（含真換行 char10、tab）
}

// URL：清洗尾端雜訊後用 new URL() 驗證；非空但無效就 throw，
// 不讓壞 URL 靜默打到 ".../n" 之類的 404 被 catch 吞掉。
export function cleanUrl(raw: string | null | undefined): string {
  const s = (raw ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\[nrt]/g, '')
    .trim()
    .replace(/\/+$/, '');           // 尾端斜線
  if (!s) return '';
  try {
    new URL(s);
  } catch {
    throw new Error(`cleanUrl: 無效網址 ${JSON.stringify(raw)}`);
  }
  return s;
}
