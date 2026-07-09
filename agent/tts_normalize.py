"""
TTS 文字正規化 — 破音字表 + 年份逐字化（確定性字串替換，無 LLM）

四落點同步清單（改任何一處規則，四處都要改，並跑共用測試向量）：
  1. ailivex agent/tts_normalize.py            —— 本檔（Python，即時語音 v16+）
  2. ailivex src/lib/tts-normalize.ts          —— 文字對話 TTS（/api/tts）
  3. UDN platform/lib/tts-normalize.ts         —— UDN 網頁 TTS
  4. UDN platform/cloud-run/podcast-worker/src/tts-normalize.ts —— UDN podcast

共用測試向量：agent/test_tts_normalize.py（Python）/ scripts/test-tts-normalize.mts（TS）
兩邊是同一組向量，改規則後兩邊都跑，漂移即紅。

規則作用在「簡體」文本上（opencc t2s 之後）——所以本檔不需要 TS 版的
「飛彈」繁體形保險規則；年份後綴字元也用簡體形（间/后 不是 間/後）。
"""
import re

# ── 年份逐字化：MiniMax 把 1999 唸成「一千九百九十九」，改成「一九九九」──
_DIGIT_ZH = {
    "0": "〇", "1": "一", "2": "二", "3": "三", "4": "四",
    "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
}
_YEAR_RE = re.compile(r"([12]\d{3})(年[代间份初末底前后]?)")


def _convert_years(text: str) -> str:
    return _YEAR_RE.sub(
        lambda m: "".join(_DIGIT_ZH.get(d, d) for d in m.group(1)) + m.group(2),
        text,
    )


# ── 破音字表（v16.4，與 TS 版 tts-normalize 同步）：借同音字定音 ──
# 每條規則都是真人耳測確認 TTS 唸錯才入表，不預防性亂加（規則有語意副作用）。
_NORMALIZE_RULES = [
    ("垃圾", "废弃物"),    # 台灣唸 lèsè，MiniMax 唸 lājī → 換近義詞
    ("晶片", "芯片"),      # opencc 後仍是「晶片」，MiniMax 對「芯片」發音更穩
    ("软体", "软件"),      # opencc 把「軟體」→「软体」，MiniMax 更熟「软件」
    ("硬体", "硬件"),      # opencc 把「硬體」→「硬体」，MiniMax 更熟「硬件」
    ("网路", "网络"),      # opencc 把「網路」→「网路」，MiniMax 更熟「网络」
    ("混淆", "混摇"),      # 台灣唸 hùn-yáo，MiniMax 唸 hùn-xiáo → 借「摇」定音
    ("飞弹", "飞蛋"),      # 彈(dàn) 被唸 tán → 借「蛋」（2026-07-06 Adam 耳測；台灣詞 MiniMax 不熟）
    ("划一划", "画一画"),   # 劃(huà) 簡化成「划」被唸 huá → 借「画」
]
_NORMALIZE_RE = [
    (re.compile(r"划(?=[^，。！？]{0,4}线)"), "画"),  # 划線／划清界线 同病；「计划路线」誤中但讀音仍對
]


def normalize_pronunciation(text: str) -> str:
    """輸入必須是簡體（opencc t2s 之後）。年份逐字化 → 破音字表。"""
    text = _convert_years(text)
    for old, new in _NORMALIZE_RULES:
        text = text.replace(old, new)
    for pat, new in _NORMALIZE_RE:
        text = pat.sub(new, text)
    return text
