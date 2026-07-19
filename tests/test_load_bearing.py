"""承重牆 pinning tests — ailiveX

這些測試守的是「無聲消失會打到真人」的 invariant（見 repo 根 FOUNDATION.md 承重牆帳）。
每個 test 對應一條承重牆；紅了代表有人動了不該動的東西——**這是系統在正常運作**，
不准 skip/xfail/刪測讓 CI 變綠（那是剪警報線）。

混合形態：
- 能離線 import 的 Python agent 邏輯 → 行為測試（真的呼叫、斷言行為）
- TS lib（memory.ts 等）→ 結構測試（regex 掃源碼，斷言 invariant 的形狀還在）

跑法（repo 根）：  python3 -m pytest tests/test_load_bearing.py -q
無 pytest 時：      python3 tests/test_load_bearing.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from agent import firestore_loader as fl  # noqa: E402
from agent import conv_tuning as ct  # noqa: E402


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def _char(soul):
    return fl.CharacterContext(
        character_id="c1", name="測試角色", soul_text=soul, voice_id_minimax="v",
    )


def _conv():
    return fl.ConversationContext(conv_id="u1_c1", summary="", messages=[])


# ── LB1：角色靈魂永不無聲消失（244 字 fallback 事件） ──────────────────
# 血案：共用 loader 被塞了不在 scope 的變數 → NameError → except 吞 → 全版本落 244 字
# FALLBACK_PROMPT，連預設角色一起斷靈魂。soul 有值時，它必須逐字出現在 system prompt。
def test_lb1_soul_appears_verbatim():
    soul = "我是林亭亭，說話溫柔但有稜角，這句是靈魂指紋 A7F3。"
    prompt = fl.build_system_prompt(_char(soul), _conv(), memories=[])
    assert soul in prompt, "soul 沒有逐字進 system prompt——靈魂被無聲吞掉了"


def test_lb1_soul_is_the_head():
    # soul 必須是 prompt 的開頭（第一個 part），不是被塞在中段可被截斷
    soul = "靈魂指紋 B2E9 開頭句。"
    prompt = fl.build_system_prompt(_char(soul), _conv(), memories=[])
    assert prompt.startswith(soul), "soul 不在 prompt 開頭——注入順序被動過"


# ── LB2：反討好天條全局恆注入（個性讓給角色，格式天條不打折） ──────────
def test_lb2_anti_sycophancy_always_injected():
    prompt = fl.build_system_prompt(_char("任意靈魂"), _conv(), memories=[])
    assert "比討好更重要的事" in prompt, "反討好天條沒注入——底模討好天性失去對沖"


# ── LB3：判斷腦 go/no-go 是確定性代碼，不是 LLM（雙腦天條） ─────────────
# should_grab_floor 必須是純函數：同輸入同輸出、回 bool、不碰網路/LLM。
def test_lb3_floor_gate_is_deterministic():
    inner = {"stance": "disagree", "activation": 0.9, "want_to_speak": True}
    conv = {"interruptThreshold": 3}
    r1 = ct.should_grab_floor(inner, conv)
    r2 = ct.should_grab_floor(inner, conv)
    assert r1 is r2 and isinstance(r1, bool), "floor-gate 不是確定性 bool"


def test_lb3_floor_gate_respects_want_to_speak():
    # want_to_speak=False → 一定不搶話（判斷腦說不說，機制就閉嘴）
    assert ct.should_grab_floor(
        {"stance": "disagree", "activation": 1.0, "want_to_speak": False}, {"interruptThreshold": 5}
    ) is False


def test_lb3_floor_gate_nudge_cap():
    # 到搶話上限 → 一定不搶（防霸麥）
    assert ct.should_grab_floor(
        {"stance": "disagree", "activation": 1.0, "want_to_speak": True},
        {"interruptThreshold": 5}, nudge_count=3, max_nudges=3,
    ) is False


# ── LB4：memories 寫入必帶 status='active'（觀察者第一晚抓到的斷根） ────
# 收斂點 writeMemory 的 doc literal 必須寫 status: 'active'；沒有＝壞資料復發。
def test_lb4_write_memory_sets_status_active():
    src = _read("src/lib/memory.ts")
    assert re.search(r"status:\s*'active'", src), \
        "writeMemory 沒寫 status: 'active'——缺欄壞資料會重新生長（v18.14.1 斷根）"


# ── LB5：記憶檢索永遠綁 (userId AND characterId)（跨用戶隔離鐵律） ──────
# 每個 memories 查詢都要同時 where userId 且 where characterId；漏一個＝洩漏別人的記憶。
def test_lb5_memory_queries_scoped_to_user_and_character():
    src = _read("src/lib/memory.ts")
    # 找所有 .collection(...memories...) 起頭到 .get() 的查詢鏈，逐段驗雙綁定
    user_scopes = len(re.findall(r"\.where\('userId',\s*'=='", src))
    char_scopes = len(re.findall(r"\.where\('characterId',\s*'=='", src))
    assert user_scopes > 0 and char_scopes > 0, "memory 查詢缺 userId/characterId 綁定"
    # 兩者數量相近（每條 userId 綁定都該配一條 characterId 綁定）
    assert abs(user_scopes - char_scopes) <= 1, \
        f"userId({user_scopes})/characterId({char_scopes}) 綁定不成對——可能有查詢漏綁"


# ── LB6：語音 TTS 簡體中文規則不可失（MiniMax 音準承重牆） ──────────────
def test_lb6_voice_tts_simplified_rule():
    assert "简体中文" in fl.DEFAULT_GLOBAL_PROMPTS["voiceRules"], \
        "voiceRules 掉了简体中文規則——MiniMax TTS 音准會壞"


if __name__ == "__main__":
    # 無 pytest 時的裸跑模式
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
