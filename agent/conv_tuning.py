"""對話手感旋鈕 — 把後台 1-5 直覺值映射成 LiveKit AgentSession / 3a 的實際參數。

convSettings（per 角色，Firestore characters.{id}.convSettings）：
  responseSpeed        1-5  接話速度（5=秒回）        → endpointing.min_delay
  interruptSensitivity 1-5  被打斷敏感度（5=一出聲就停）→ interruption.min_duration
  imThreshold          1-5  主動程度（3a 冷場開口）
  interruptThreshold   1-5  搶話程度（3b 切進別人的話，暫存）

全部預設 3 → 對齊 LiveKit 現行預設行為（不設等於沒變）。
"""
from typing import Any


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
