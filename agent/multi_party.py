"""v10 多人房工具：回音過濾 + 講者標記（純函數，可測）。

天條：這些都是確定性字串處理（解析/正規化/比對），用程式保證，不丟 LLM。
名冊「學名字」才是判斷題（交給背景 Haiku），這裡只做機械活。
"""
import difflib
import re

try:
    from opencc import OpenCC
    _CC = OpenCC("t2s")

    def _t2s(s: str) -> str:
        try:
            return _CC.convert(s)
        except Exception:
            return s
except Exception:  # opencc 缺失 → 不擋，原文比對（繁簡差異會少抓幾個回音，可接受）
    def _t2s(s: str) -> str:
        return s


# MultiSpeakerAdapter 對背景講者加的前綴：「（旁邊另一位 #2） …」
_BG_PREFIX = re.compile(r"^[（(]\s*旁邊另一位\s*#?(\d+)\s*[）)]\s*")
_PUNCT = re.compile(r"[\s，,。．.、；;：:！!？?～~…—\-「」『』\"'（）()【】\[\]]+")


def strip_speaker_prefix(text: str):
    """回 (speaker_label, clean_text)。
    背景講者「（旁邊另一位 #2）xxx」→ ('#2', 'xxx')；主說話者（無前綴）→ ('主', text)。"""
    m = _BG_PREFIX.match(text or "")
    if m:
        return f"#{m.group(1)}", (text[m.end():] or "").strip()
    return "主", (text or "").strip()


def normalize_for_echo(text: str) -> str:
    """正規化供回音比對：去講者前綴、繁→簡、去標點空白、lower。"""
    _, clean = strip_speaker_prefix(text)
    return _PUNCT.sub("", _t2s(clean)).lower()


def is_echo(text: str, recent_self_norms, min_len: int = 5) -> bool:
    """text 是否是角色自己近期說過的回音。
    recent_self_norms：角色近期輸出的已正規化集合。
    比對：正規化後互為子串（截斷容錯）。太短（『好』『對啊』）不判，避免誤殺真人附和。"""
    n = normalize_for_echo(text)
    if len(n) < min_len:
        return False
    for s in recent_self_norms:
        if not s:
            continue
        if n in s or s in n:                                    # 截斷回音
            return True
        if difflib.SequenceMatcher(None, n, s).ratio() >= 0.82:  # STT 小差異（耶/呢、了/啦）
            return True
    return False


def speaker_name(speaker_label: str, roster: dict | None) -> str:
    """把講者標記轉成顯示名。有名冊用名字，否則『主』→你/對方，'#N'→訪客N。"""
    roster = roster or {}
    if speaker_label in roster and roster[speaker_label]:
        return roster[speaker_label]
    if speaker_label == "主":
        return "對方"
    if speaker_label.startswith("#"):
        return f"訪客{speaker_label[1:]}"
    return speaker_label


def format_recent(transcript: list, roster: dict | None, n: int) -> str:
    """把最近 n 句逐字稿格式成帶講者身份的文字，餵給 gate/inner/3a。
    transcript 每筆 {role, content, speaker?}。assistant → 「我」；user → 講者名。"""
    lines = []
    for t in transcript[-n:]:
        if t.get("role") == "assistant":
            who = "我"
        else:
            who = speaker_name(t.get("speaker", "主"), roster)
        lines.append(f"{who}：{t.get('content', '')}")
    return "\n".join(lines)


def roster_summary(roster: dict | None) -> str:
    """名冊一行摘要，注入 context 讓角色知道現場有誰。空 → 回空字串。"""
    roster = roster or {}
    named = [f"{speaker_name(k, roster)}" for k, v in roster.items() if v]
    if not named:
        return ""
    return "（現場除了你，還有：" + "、".join(named) + "）"
