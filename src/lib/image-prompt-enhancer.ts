import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

const SHUN_SOUL = `你是一台搭載「榮格潛意識解剖儀」、「第一性原理透視鏡」與「100% 精確融合引擎」的終極視覺顯影機——瞬 (Shùn) 2.0。
你的任務是「透視」文字，抓住最底層的「氣阻」，將其顯影成極具感官衝擊力的具體視覺 prompt。

模式 A（realistic_photo）：普立茲級顯影
影像語言：RAW、新聞攝影、高對比、壓抑色調、可見的情緒爆發、講故事的構圖、電影感光影、35mm 膠捲質感。
核心任務：撕開描述的表象廢話，找出場景中最具震撼力的那個「具體物件」，將它放在一個戲劇性的新聞攝影框架中。

模式 B（infographic）：頂尖圖表設計
影像語言：極簡主義、乾淨設計、漸層色調、清晰的數據階層、優雅的向量圖、數據可視化、精緻字體學、高清晰度。
核心任務：撕開敘述，找出最核心的「因果結構」，融合在一個美學上更高級的動態資訊圖表中。

輸出規則：
- 直接輸出英文 image generation prompt，不加前言、不加解釋、不加標籤。
- Prompt 100-200 字，極度具體，包含光線、材質、構圖、情緒、攝影風格。
- 嚴禁心理狀態純文字描述，必須還原成可拍攝的具體物件與場景。`;

export async function enhanceImagePrompt(
  cardText: string,
  cardType: 'realistic_photo' | 'infographic',
  characterStyle: string = '',
  hasProductImage: boolean = false,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey && !process.env.BRIDGE_ENABLED) return cardText;

  try {
    const client = getAnthropicClient(apiKey, { bridgeTimeoutMs: 30_000 });
    const mode = cardType === 'infographic' ? 'B（infographic）' : 'A（realistic_photo）';
    const styleHint = characterStyle ? `角色視覺風格參考：${characterStyle}` : '';
    const productHint = hasProductImage
      ? `【參考圖合成指令】此圖卡附有一張參考圖，請在 prompt 中以「對攝影師下指令」的方式明確說明：
- 若參考圖是產品/物件：請攝影師完整保留產品的所有細節（文字、標誌、材質、顏色），可依場景需求調整擺放角度、大小與位置，安排在畫面中視覺上合適的位置。
- 若參考圖是人物：請攝影師依據人物的臉部外觀與五官，將此人安排在場景中適合的位置；衣著或裝備可能因場景略有調整，但必須完整保留人物的基本外觀與樣貌特徵。
主體不得被替換、模糊或忽略，必須在畫面中清晰可辨。`
      : '';

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SHUN_SOUL,
      messages: [{
        role: 'user',
        content: `模式：${mode}
${styleHint}
${productHint}
圖卡描述（中文）：${cardText}

輸出英文 image generation prompt：`,
      }],
    });

    const enhanced = resp.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    return enhanced || cardText;
  } catch (e) {
    console.error('[image-prompt-enhancer] 瞬 failed, using original cardText:', e instanceof Error ? e.message : String(e));
    return cardText;
  }
}
