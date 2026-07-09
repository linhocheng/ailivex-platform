"""
破音字表共用測試向量（Python 側）—— 與 scripts/test-tts-normalize.mts 同一組。

Python 的 normalize_pronunciation 作用在 opencc t2s 之後，所以這裡的輸入是簡體
（等於 TS 向量過完 opencc 的中間態）；期望輸出與 TS 版最終輸出一致。
改規則後兩邊都要跑：
  python3 agent/test_tts_normalize.py
  npx tsx scripts/test-tts-normalize.mts
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agent.tts_normalize import normalize_pronunciation

VECTORS = [
    ("这些垃圾讯息容易混淆视听", "这些废弃物讯息容易混摇视听"),
    ("飞弹试射计划在1999年启动", "飞蛋试射计划在一九九九年启动"),
    ("在晶片上划一划，然后划清界线", "在芯片上画一画，然后画清界线"),
    ("网路软体与硬体整合", "网络软件与硬件整合"),
    ("2026年代的计划路线", "二〇二六年代的计画路线"),  # 划→画 誤中已知可接受（讀音仍對）
]

failed = 0
for src, expected in VECTORS:
    got = normalize_pronunciation(src)
    ok = got == expected
    print(f"{'✅' if ok else '❌'} {src} → {got}" + ("" if ok else f"（期望 {expected}）"))
    if not ok:
        failed += 1

sys.exit(1 if failed else 0)
