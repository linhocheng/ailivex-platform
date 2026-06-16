"""v11 聲紋核心：speaker embedder + 線上分群（純邏輯，可單測，無 LiveKit import）。

天條對齊 v10 多人房：機制（分群/比對/合併）是確定性數學，用程式保證，不丟 LLM。
LLM 只管「學名字」（背景 Haiku 名冊）——那是判斷題，留在 realtime_agent。

分工：
  - load_embedder()        : 載入 speaker model（speechbrain ECAPA 預設；prewarm 呼叫一次）。
                             失敗回 None → 上層降級成 v10（VP off）。
  - OnlineClusterer        : 線上 cosine-centroid 分群，吐穩定的群索引（給 #N 用）。
                             running-mean 質心 = 通話中漸進變準；match/new/ambiguous 三帶；
                             合併護欄（同一人被拆兩群就併回）；上限 VP_MAX_CLUSTERS。
  - VoiceprintEngine       : embedder + clusterer 綁一起；embed_and_assign() 給 audio_tap 用。

設計取捨（場景＝共享單麥、可口頭糾正、enhance accuracy）：
  ambiguous 帶（介於 new 與 match 之間）→ 併進最像的既有群，不開新群。
  寧可偶爾把兩人暫時當一人（之後質心分化或口頭糾正會修），也不要把一個人裂成一堆幽靈訪客。
"""
from __future__ import annotations

import logging
import os

import numpy as np

logger = logging.getLogger("ailivex-realtime-v11")


# ── env 旋鈕（cloudbuild --set-env-vars 注入；改 env 不必改 code） ──
def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _envi(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# 預設值對齊 plan，正式靠 live call 調。
VP_MATCH = _envf("VP_MATCH", 0.60)        # ≥ 這個 cosine → 同一群（確定 match）
VP_NEW = _envf("VP_NEW", 0.45)            # < 這個 → 夠不像，開新群（其間是 ambiguous）
VP_MERGE = _envf("VP_MERGE", 0.72)        # 兩群質心 ≥ 這個 → 視為同人，合併
VP_MAX_CLUSTERS = _envi("VP_MAX_CLUSTERS", 6)
VP_MIN_SEG = _envf("VP_MIN_SEG", 0.6)     # 短於這個秒數的語段不嵌入（雜訊/附和）
EMB_DIM_HINT = 192                        # ECAPA / CAM++ 都是 192；僅供 log，分群本身不依賴維度


def _l2norm(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < 1e-9:
        return v
    return v / n


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """兩個已 L2-normalize 的向量的 cosine（= 內積）。未正規化也安全（這裡會正規化）。"""
    return float(np.dot(_l2norm(a), _l2norm(b)))


# ──────────────────────────────────────────────────────────────────────────
# Embedder（speechbrain ECAPA 預設；torch import 只在這裡發生）
# ──────────────────────────────────────────────────────────────────────────
class _EcapaEmbedder:
    """包 speechbrain EncoderClassifier。embed(wav_16k_float32_mono) → np.ndarray(192)。"""

    def __init__(self, model):
        self._model = model

    def embed(self, wav_16k: np.ndarray) -> np.ndarray | None:
        try:
            import torch
            x = torch.from_numpy(np.ascontiguousarray(wav_16k, dtype=np.float32)).unsqueeze(0)
            with torch.no_grad():
                emb = self._model.encode_batch(x)          # (1, 1, D)
            v = emb.squeeze().detach().cpu().numpy().astype(np.float32)
            return _l2norm(v)
        except Exception as e:
            logger.error(f"VP embed failed: {e}")
            return None


def load_embedder():
    """prewarm 呼叫：載入 speaker model（CPU）。失敗 raise / 回 None → 上層降級 v10。

    模型在 Dockerfile build 時烤進 image（/app/models/ecapa），冷啟不依賴線上下載。
    Phase 2 若改 CAM++(modelscope) 換這個函式內部即可，對外介面不變。
    """
    model_dir = os.environ.get("VP_MODEL_DIR", "/app/models/ecapa")
    from speechbrain.inference.speaker import EncoderClassifier
    model = EncoderClassifier.from_hparams(
        source=model_dir,
        savedir=model_dir,
        run_opts={"device": "cpu"},
    )
    logger.info(f"VP embedder loaded (ECAPA, dir={model_dir})")
    return _EcapaEmbedder(model)


# ──────────────────────────────────────────────────────────────────────────
# 線上分群（純 numpy，可單測）
# ──────────────────────────────────────────────────────────────────────────
class OnlineClusterer:
    """Cosine-centroid 線上分群。assign(emb) → (cluster_idx, confidence)。

    群索引穩定（出現順序），上層格式化成 '#1'/'#2'…（接 v10 既有的 #N 命名空間）。
    質心用 running mean 累積（看越多越準）；ambiguous 帶併進最像的群（不裂群）；
    定期掃描合併過近的兩群（修正早期誤裂）。
    """

    def __init__(self, match: float = VP_MATCH, new: float = VP_NEW,
                 merge: float = VP_MERGE, max_clusters: int = VP_MAX_CLUSTERS):
        self.match = match
        self.new = new
        self.merge = merge
        self.max_clusters = max_clusters
        self._centroids: list[np.ndarray] = []   # 已 L2-normalize
        self._counts: list[int] = []

    @property
    def num_clusters(self) -> int:
        return len(self._centroids)

    def _best(self, emb: np.ndarray) -> tuple[int, float]:
        if not self._centroids:
            return -1, -1.0
        sims = [cosine(emb, c) for c in self._centroids]
        idx = int(np.argmax(sims))
        return idx, float(sims[idx])

    def _update_centroid(self, idx: int, emb: np.ndarray) -> None:
        n = self._counts[idx]
        merged = (self._centroids[idx] * n + _l2norm(emb)) / (n + 1)
        self._centroids[idx] = _l2norm(merged)
        self._counts[idx] = n + 1

    def assign(self, emb: np.ndarray) -> tuple[int, float]:
        """把一個語段嵌入歸到群，回 (cluster_idx, confidence=該群 cosine)。"""
        emb = _l2norm(np.asarray(emb, dtype=np.float32))
        idx, sim = self._best(emb)

        # 1) 確定 match → 併入並強化質心
        if idx >= 0 and sim >= self.match:
            self._update_centroid(idx, emb)
            self._maybe_merge()
            return idx, sim

        # 2) 夠不像且還有名額 → 開新群
        if (idx < 0 or sim < self.new) and self.num_clusters < self.max_clusters:
            self._centroids.append(emb.copy())
            self._counts.append(1)
            return self.num_clusters - 1, 1.0

        # 3) ambiguous（new ≤ sim < match），或已達群上限 → 併進最像的群（不裂群）
        #    質心輕量更新（避免被疑似別人的語段污染太快）
        if idx >= 0:
            self._update_centroid(idx, emb)
            self._maybe_merge()
            return idx, sim

        # 理論上到不了（idx<0 已在 2 處理），保底開新群
        self._centroids.append(emb.copy())
        self._counts.append(1)
        return self.num_clusters - 1, 1.0

    def _maybe_merge(self) -> None:
        """掃描所有群對，質心 cosine ≥ merge → 合併（同一人早期被誤裂修正）。"""
        n = self.num_clusters
        for i in range(n):
            for j in range(i + 1, n):
                if cosine(self._centroids[i], self._centroids[j]) >= self.merge:
                    self._merge_into(i, j)
                    return self._maybe_merge()   # 索引變了，重掃一輪

    def _merge_into(self, i: int, j: int) -> None:
        """把 j 併進 i（保留較小索引 = 較早出現的群，維持 #N 穩定）。"""
        ci, cj = self._counts[i], self._counts[j]
        merged = (self._centroids[i] * ci + self._centroids[j] * cj) / (ci + cj)
        self._centroids[i] = _l2norm(merged)
        self._counts[i] = ci + cj
        del self._centroids[j]
        del self._counts[j]


def cluster_label(idx: int) -> str:
    """群索引 → 接 v10 命名空間的 '#N'（1-based）。speaker_name('#N') 已會顯示成『訪客N』。"""
    return f"#{idx + 1}"


# ──────────────────────────────────────────────────────────────────────────
# Engine：embedder + clusterer 綁一起（audio_tap 用）
# ──────────────────────────────────────────────────────────────────────────
class VoiceprintEngine:
    """embed_and_assign(wav_16k) → ('#N', confidence) 或 None。

    embedder=None（載入失敗）→ 永遠回 None，上層自然降級 v10。embed 是 CPU 同步，
    呼叫端（audio_tap）用 asyncio.to_thread 包起來，別卡 realtime 路徑。
    """

    def __init__(self, embedder=None, clusterer: OnlineClusterer | None = None):
        self.embedder = embedder
        self.clusterer = clusterer or OnlineClusterer()

    def embed_and_assign(self, wav_16k: np.ndarray) -> tuple[str, float] | None:
        if self.embedder is None:
            return None
        emb = self.embedder.embed(wav_16k)
        if emb is None:
            return None
        idx, conf = self.clusterer.assign(emb)
        return cluster_label(idx), conf
