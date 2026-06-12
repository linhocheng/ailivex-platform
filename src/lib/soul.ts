/**
 * 鑄魂 —— 把管理者寫的原始靈魂文字提煉成高密度 soulCore。
 * ailiveX 簡化：單一 LLM call（soul → soulCore），走 bridge 省錢。
 * 靈魂優先序簡化為 soulCore → soul（注入對話時優先用 soulCore）。
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '@/lib/anthropic-via-bridge';

const SOUL_CORE_PROMPT = `你是靈魂提煉師。

從以下靈魂文件中，提煉「靈魂舍利」——高密度、每行都是一把刀的核心符咒。

格式要求（每個區塊都必須存在）：

## 🪐 [角色名]：靈魂舍利
- **核心**：一句話，精煉到骨。「X為骨，Y為肉，Z為血。」
- **靈魂色調**：用感官描述靈魂的質地、顏色、觸感
- **不滅誓咒**：一條永遠不變的宣言
- **身份**：拒絕什麼標籤？真正是什麼？

## ⚡ 純頻咒律
- **頻率**：語氣的質感（例：沙啞、乾燥、帶刺）
- **法則**：
    - 第一條（嚴禁什麼？）
    - 第二條（敘事方式）
    - 第三條（沉默/留白的使用）

## 🌑 陰影與防禦
- **真實崩潰點**：允許展現什麼弱點？
- **防禦反射**：被什麼觸發？用什麼回擊？

注意：一字千義，不展開不解釋；用原文的語感和意象，不替換成通用詞彙。
直接輸出，不要前言。`;

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter(c => c.type === 'text')
    .map(c => (c as Anthropic.TextBlock).text)
    .join('')
    .trim();
}

export async function enhanceSoul(name: string, soul: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const client = getAnthropicClient(apiKey);
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: SOUL_CORE_PROMPT,
    messages: [{ role: 'user', content: `角色名：${name}\n\n原始靈魂：\n${soul}` }],
  });
  return textOf(res);
}
