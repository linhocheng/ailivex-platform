/**
 * 破音字表共用測試向量（TS 側）—— 與 agent/test_tts_normalize.py 同一組。
 * TS 版跑完整管線（繁體輸入 → 年份 → opencc → 破音字表）；期望輸出與 Python 版一致。
 * 改規則後兩邊都要跑：
 *   npx tsx scripts/test-tts-normalize.mts
 *   python3 agent/test_tts_normalize.py
 */
import { normalizeTTSText } from '../src/lib/tts-normalize';

const VECTORS: Array<[string, string]> = [
  ['這些垃圾訊息容易混淆視聽', '这些废弃物讯息容易混摇视听'],
  ['飛彈試射計畫在1999年啟動', '飞蛋试射计划在一九九九年启动'],
  ['在晶片上劃一劃，然後劃清界線', '在芯片上画一画，然后画清界线'],
  ['網路軟體與硬體整合', '网络软件与硬件整合'],
  ['2026年代的計劃路線', '二〇二六年代的计画路线'], // 划→画 誤中已知可接受（讀音仍對）
];

let failed = 0;
for (const [src, expected] of VECTORS) {
  const got = normalizeTTSText(src);
  const ok = got === expected;
  console.log(`${ok ? '✅' : '❌'} ${src} → ${got}${ok ? '' : `（期望 ${expected}）`}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
