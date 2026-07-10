"""
v16.5 道別偵測＋語意重複防護 測試向量
測資來源：2026-07-10 Tracy 通話實錄（3a 重複發話 bug 現場）。
跑法：python3 agent/test_conv_guards.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agent.conv_tuning import is_farewell, is_semantic_repeat  # noqa: E402

FAREWELL_YES = [
    "拜拜。",
    "拜拜，下次见啰。",
    "好，下次见。",
    "拜拜，下次見。",          # 繁體
    "晚安。",
    "那先這樣，掰掰",
    "886",
    "好，下次见。去跟他们说那句话。",  # 道別＋叮嚀混句：token 靠前但全句不長，仍算道別
]

FAREWELL_NO = [
    "上次说拜拜说了好几次，结果还是舍不得走。跟那个合伙人说了吗？",  # 句中提及，不是道別
    "我刚刚说我再找你聊这样子，OK 吗。",
    "你觉得你现在最大的障碍在哪里？",
    "嗯。",
    "",
    "他昨天跟我说晚安之后就把电话挂了，我觉得他在敷衍我",  # 句中提及晚安
]

# (candidate, recent, expected)
REPEAT_CASES = [
    # 實錄鐵證：3a 把回合路剛問過的問題原句再問一次（繁簡混用）
    ("那你今天來，是要調教我，還是有別的事？",
     ["嗯，我知道。这件事你做了一段时间了。那你今天来，是要调教我，还是有别的事？"], True),
    # 實錄：回合路回「好，去忙。有议题再来。」後 3a 又說「好，去忙。等你。」
    ("好，去忙。等你。", ["好，去忙。有议题再来。"], True),
    # 完全相同
    ("拜拜，下次见。", ["拜拜，下次见。"], True),
    # 短句只擋完全相同：「嗯，好。」不誤殺
    ("嗯，好。", ["好，下次见。"], False),
    ("嗯，好。", ["嗯，好。"], True),
    # 正常的新話不誤殺
    ("哎，你说你会大笑这个问题是什么意思，你想测试我吗？", ["会啊，怎么了？"], False),
    ("然后呢，他说了什么？", ["哦，说了啊。他什么反应？"], False),
    ("你有没有真的给过那个方式一个机会？", ["我觉得你说的有一部分是真的。"], False),
    # 包含關係
    ("去跟他们说那句话。", ["好，下次见。去跟他们说那句话。"], True),
    # 空值防呆
    ("", ["拜拜"], False),
    ("拜拜", [""], False),
]


def main() -> int:
    failed = 0
    for t in FAREWELL_YES:
        if not is_farewell(t):
            print(f"FAIL is_farewell should be True : {t!r}")
            failed += 1
    for t in FAREWELL_NO:
        if is_farewell(t):
            print(f"FAIL is_farewell should be False: {t!r}")
            failed += 1
    for cand, recent, expected in REPEAT_CASES:
        got = is_semantic_repeat(cand, recent)
        if got != expected:
            print(f"FAIL is_semantic_repeat expected {expected}: cand={cand!r} recent={recent!r}")
            failed += 1
    total = len(FAREWELL_YES) + len(FAREWELL_NO) + len(REPEAT_CASES)
    print(f"{'ALL PASS' if failed == 0 else 'FAILED'} — {total - failed}/{total}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
