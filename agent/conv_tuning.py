"""對話手感旋鈕 — 把後台 1-5 直覺值映射成 LiveKit AgentSession / 3a 的實際參數。

convSettings（per 角色，Firestore characters.{id}.convSettings）：
  responseSpeed        1-5  接話速度（5=秒回）        → endpointing.min_delay
  interruptSensitivity 1-5  被打斷敏感度（5=一出聲就停）→ interruption.min_duration
  imThreshold          1-5  主動程度（3a 冷場開口）
  interruptThreshold   1-5  搶話程度（3b 切進別人的話，暫存）

全部預設 3 → 對齊 LiveKit 現行預設行為（不設等於沒變）。
"""
import re
from typing import Any


# ── 群聊發言權判斷式（確定性，不丟 LLM）─────────────────────────────
# 場景：多個角色 + 一個人在同一場對話。一句話結尾若「點名」了某個特定角色，
# 那除了被點到的人，其他角色都要保持靜默、不要幫腔。
# 這是純文字模式比對（指名 vs 單純提及），天條：這種判斷用程式保證 100%，不拜託模型自律。

# 名字後面接這些 = 在招呼/指派他講話（指名），不是單純提到
_ADDR_POST = (
    r"你|妳|您|說說|说说|講講|讲讲|說|说|講|讲|回答|回应|回應|答|分享|發言|发言|"
    r"聊聊|聊|談談|谈谈|談|谈|來說|来说|來講|来讲|接|補充|补充|表示|說一下|说一下|講一下|讲一下"
)
# 名字前面有這些意圖詞 = 在點名某人
_ADDR_PRE = (
    r"請|请|換|换|輪到|轮到|點|点|找|叫|讓|让|交給|交给|想聽聽|想听听|聽聽|听听|"
    r"問問|问问|拜託|拜托|麻煩|麻烦|有請|有请"
)
# 代名詞 / 集合詞不算「被點名的角色」
_PRONOUNS = {"我", "你", "妳", "您", "他", "她", "它", "牠", "咱", "大家", "各位",
             "你們", "你们", "我們", "我们", "他們", "他们", "誰", "谁"}


def _name_variants(name: str) -> list[str]:
    n = (name or "").strip()
    if not n:
        return []
    out = {n}
    if n.isascii():
        out |= {n.lower(), n.upper(), n.capitalize()}
    return [x for x in out if x]


def _is_addressed(text: str, name: str) -> bool:
    """text 裡 name 是否處在『被點名/被招呼』的位置（而非單純被提到）。"""
    for nm in _name_variants(name):
        if nm in _PRONOUNS:
            continue
        r = re.escape(nm)
        # 1) 名字後接 你/妳/您 或 招呼/指派動詞：「Tracy你」「福哥說說」
        if re.search(r + r"\s*(?:" + _ADDR_POST + r")", text):
            return True
        # 2) 名字前有點名意圖詞：「請福哥」「換張立」「想聽聽 Tracy」
        if re.search(r"(?:" + _ADDR_PRE + r")\s*" + r, text):
            return True
        # 3) 句首或逗號後直接呼名 + 標點（vocative）：「福哥，…」「…，Tracy？」
        if re.search(r"(?:^|[，,、。！!？?\s])" + r + r"\s*[，,、。！!？?～~]", text):
            return True
    return False


def resolve_addressed(text: str, my_names, peer_names=None) -> str:
    """一句話是否點名了某個角色 → 'me' / 'peer' / 'none'。

    'me'   點到我（我的名字/別名被招呼）           → 我可以回。
    'peer' 點到別人（不是我）                        → 我保持靜默、不幫腔。
    'none' 沒有明確點名任何人                        → 照常規則。

    同時點到我和別人 → 'me' 勝（我確實被叫到）。
    需要 peer_names（在場其他角色的名字＋別名）才認得出「點到的是別人」。
    """
    text = text or ""
    my = [n for n in (my_names or []) if n and n.strip()]
    peers = [n for n in (peer_names or []) if n and n.strip()]
    if any(_is_addressed(text, n) for n in my):
        return "me"
    if any(_is_addressed(text, n) for n in peers):
        return "peer"
    return "none"


def _clamp(v, lo=1, hi=5, default=3) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def build_turn_handling(conv: dict | None) -> dict[str, Any]:
    conv = conv or {}
    rs = _clamp(conv.get("responseSpeed", 3))
    isens = _clamp(conv.get("interruptSensitivity", 3))
    # responseSpeed 1→0.8s … 3→0.5s(預設) … 5→0.2s
    min_delay = round(0.8 - (rs - 1) * 0.15, 3)
    # interruptSensitivity 1→0.9s … 3→0.5s(=預設) … 5→0.1s
    min_duration = round(0.9 - (isens - 1) * 0.2, 3)
    return {
        "endpointing": {"min_delay": min_delay},
        "interruption": {"min_duration": min_duration},
    }


def get_im_threshold(conv: dict | None) -> int:
    return _clamp((conv or {}).get("imThreshold", 3))


def get_temperature(conv: dict | None, default: float = 0.4) -> float:
    """LLM temperature（0.1–1.0，越低越收斂/越不演）。沒設用 default。"""
    try:
        v = float((conv or {}).get("temperature"))
        return max(0.1, min(1.0, v))
    except (TypeError, ValueError):
        return default


def get_interrupt_threshold(conv: dict | None) -> int:
    return _clamp((conv or {}).get("interruptThreshold", 3))


_SINGLE_PRONOUNS = {p for p in _PRONOUNS if len(p) == 1}

# 讓位偵測專用意圖詞（保守集）：排除 点/點/找/叫 等一字多義的高頻口語字，
# 只留指派語意明確的詞。避免「晚一点」「有点」被誤判成「點名第三方」。
_REDIRECT_PRE = (
    r"請|请|換|换|輪到|轮到|讓|让|交給|交给|"
    r"想聽聽|想听听|聽聽|听听|拜託|拜托|麻煩|麻烦|有請|有请"
)
# 說話動詞：把棒子交給人「說話」的明確信號（區別於「讓人難過」「請問一下」）
_SPEAK_VERB = (
    r"說|说|講|讲|分享|發言|发言|回答|回應|回应|補充|补充|"
    r"表示|發表|发表|來說|来说|談談|谈谈|聊聊|發表意見|发表意见"
)


def is_redirecting_away(text: str, agent_names: list[str] | None = None) -> bool:
    """text 是否在把發言機會交給第三方（非 AI）？

    True  → AI 應靜默讓位（raise StopResponse）
    False → 正常回話

    判斷式（regex），修法 B：意圖詞 + 名字 + 說話動詞 三件齊全才算讓位。
    取捨：寧可漏判（角色多回一句）也不誤判（角色閉嘴）；閉嘴體感最差。

    1. AI 被明確點名 → False（我被叫到，應回）
    2. 「請/讓/換 + [非代詞名字] + 說/講/發言」→ True（在叫別人說話）
    3. 其他 → False

    例：「接下來請 xxx 說」→ True；「晚一點再聊」→ False；「讓人難過」→ False；「請問一下」→ False
    """
    text = text or ""
    my_names = [n for n in (agent_names or []) if n and n.strip()]

    # AI 自己被明確點名 → 應該回話
    if any(_is_addressed(text, n) for n in my_names):
        return False

    # [意圖詞] [名字 1-4 非代詞] [0-3 連接字 先/也/就/再/來…] [說話動詞]
    name = r"([^\s，,。！!？?、\u0000-\u001f]{1,4}?)"
    conn = r"[先也就還还都再來来,，\s]{0,3}"
    pat = r"(?:" + _REDIRECT_PRE + r")\s*" + name + conn + r"(?:" + _SPEAK_VERB + r")"
    for m in re.finditer(pat, text):
        candidate = m.group(1).strip()
        if not candidate:
            continue
        # 首字/前綴是代詞（你/妳/他/我/大家 等）→ 跳過
        if candidate[0] in _SINGLE_PRONOUNS:
            continue
        if any(candidate.startswith(p) for p in _PRONOUNS):
            continue
        if any(n.lower() == candidate.lower() for n in my_names):
            continue
        return True

    return False


# ── v8 發言權控制：被點名抓麥克風 / 交棒第三方就閉嘴 ──────────────────

def is_addressed_to_me(text: str, agent_names: list[str] | None = None) -> bool:
    """text 是否明確點名了我（角色名/別名被招呼）。被點名 → 抓麥克風（不可打斷）。"""
    text = text or ""
    return any(_is_addressed(text, n) for n in (agent_names or []) if n and n.strip())


# 交棒偵測路徑2 的假名字停用詞（口語高頻、非人名）
_HANDOFF_FILLERS = {
    "這個", "这个", "那個", "那个", "等等", "等一下", "等下", "老實", "老实",
    "簡單", "简单", "反正", "總之", "总之", "現在", "现在", "待會", "待会",
    "剛剛", "刚刚", "剛才", "刚才", "這樣", "这样", "那樣", "那样", "其實", "其实",
    "時候", "时候", "然後", "然后", "接下來", "接下来", "這邊", "这边", "什麼", "什么",
}


def is_floor_handoff(text: str, agent_names: list[str] | None = None) -> bool:
    """text 是否把發言權交給第三方（非我）？True → 我進讓位窗、3a 也閉嘴。

    路徑1：請/讓/換 + 名字 + 說話動詞（沿用 is_redirecting_away 的保守判斷）
    路徑2：[名字] 你/妳/您 [先/也/再…] 說話動詞 —— 例「張大哥你先說」「張立你說」
           用「你」當招呼錨點 + 假名字停用詞，避免「長話短說」「剛才你說的」誤觸。
    """
    text = text or ""
    my = [n for n in (agent_names or []) if n and n.strip()]

    # 我自己被點名 → 不是交棒（我要講）
    if is_addressed_to_me(text, my):
        return False

    # 路徑1
    if is_redirecting_away(text, my):
        return True

    # 路徑2：[名字] + 你/妳/您 + [0-4 連接字] + 說話動詞
    name = r"([^\s，,。！!？?、\u0000-\u001f]{2,4}?)"
    pat = name + r"(?:你|妳|您)[^，,。！!？?、\s]{0,4}?(?:" + _SPEAK_VERB + r")"
    for m in re.finditer(pat, text):
        c = m.group(1).strip()
        if not c:
            continue
        # 含任何假名字停用詞（如「什麼時候」含「時候」）→ 跳過
        if any(f in c for f in _HANDOFF_FILLERS):
            continue
        if c[0] in _SINGLE_PRONOUNS or any(c.startswith(p) for p in _PRONOUNS):
            continue
        if any(n.lower() == c.lower() for n in my):
            continue
        return True

    return False


# ── v6 浮動門檻：靜態人格 × 當下內部狀態 → 行為決策 ──────────────────
# 天條分工：LLM（Haiku 判斷腦）只產出 inner = {stance, activation, want_to_speak}；
# 「要不要搶話」是純規則，用程式保證 100%，不丟 LLM。

def should_grab_floor(inner: dict | None, conv: dict | None,
                      nudge_count: int = 0, max_nudges: int = 3) -> bool:
    """確定性：根據內部狀態 + 角色基準人格，決定此刻是否該主動搶話。

    inner: 判斷腦（Haiku）產出 {stance, activation, want_to_speak}
      stance     : 'agree' | 'disagree' | 'neutral'
      activation : 0.0-1.0 話題跟靈魂的共鳴度
    conv : 角色 convSettings（含 interruptThreshold 1-5 = 天生愛插話度）
    nudge_count / max_nudges : 已搶話次數上限保護（避免霸麥）
    """
    inner = inner or {}
    if nudge_count >= max_nudges:
        return False
    if not inner.get("want_to_speak"):
        return False
    activation = float(inner.get("activation", 0.0) or 0.0)
    disagree = inner.get("stance") == "disagree"
    base = get_interrupt_threshold(conv)          # 1-5
    base_norm = (base - 1) / 4.0                   # 0-1：天生傾向
    # 綜合衝動 = 共鳴 + 不同意加成 + 天生傾向
    impulse = activation + (0.3 if disagree else 0.0) + base_norm * 0.4
    # 不同意時門檻低（更容易搶）；同意時要更高共鳴才值得插話
    threshold = 0.7 if disagree else 1.05
    return impulse >= threshold


def parse_inner_state(raw: str) -> dict:
    """把判斷腦的 JSON 輸出 deterministic 解析成 inner state（壞輸出回安全預設，不再丟 LLM 修）。"""
    import json
    default = {"stance": "neutral", "activation": 0.0, "want_to_speak": False, "what_to_say": ""}
    if not raw or not raw.strip():
        return default
    s = raw.strip()
    # 容錯：剝掉 markdown code fence
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", s).strip()
    # 抓第一個 {...} 區塊
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if not m:
        return default
    try:
        d = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
        return default
    stance = d.get("stance", "neutral")
    if stance not in ("agree", "disagree", "neutral"):
        stance = "neutral"
    try:
        activation = max(0.0, min(1.0, float(d.get("activation", 0.0))))
    except (TypeError, ValueError):
        activation = 0.0
    return {
        "stance": stance,
        "activation": activation,
        "want_to_speak": bool(d.get("want_to_speak", False)),
        "what_to_say": str(d.get("what_to_say", "") or "")[:200],
    }
