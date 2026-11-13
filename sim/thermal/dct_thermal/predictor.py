"""잔차 모델 + 불확실성 + 범위 밖 안전장치. 센서 생성기(L2)가 부르는 입구다.

입력: 샘플 조건(팬 레벨, 줄별 전력, 제거한 랙), 우리 솔버의 랙 입구 온도, 우리 솔버가 낸 유량 정보(`aisle_leak_m3s`, `supply_m3s`).
출력: 랙마다 보정한 온도, 불확실성(앙상블 퍼짐 sigma), 90% 구간, 신뢰 등급, 샘플 단위 새로움과 되돌림 여부.

설계 근거(`experiments/results/E5_surrogate_residual_model.md` 8장):
 - 앙상블 퍼짐(트리 사이 표준편차)은 실제 오차와 잘 맞는다(순위 상관 0.88). 그래서 **구간과 신뢰 등급**에 쓴다.
 - **퍼짐이 크다고 우리 솔버 값으로 되돌리면 오히려 오차가 커진다**(퍼짐이 큰 곳이 우리 솔버가 크게 틀리는 곳이고, 그곳에서도 보정이 더 낫다). 그래서 퍼짐으로는 되돌리지 않는다.
 - 우리 솔버 값으로 되돌리는 경우는 **입력이 학습 범위를 확실히 벗어난 때**뿐이다: 줄 전력이 학습 범위(6~14 kW) 밖, 팬 레벨이 0~1 밖, 제거한 랙이 학습 최대(3기)보다 많음, 모르는 랙 이름.
 - 시각화 목적의 실험이며 공학적 정확성을 주장하지 않는다. 대리 모델은 OpenFOAM 10 cm 격자 결과를 흉내 낼 뿐이다.
"""
from __future__ import annotations

import pickle
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor

from . import residual_model as rm

# 신뢰 등급의 경계(앙상블 퍼짐, 도). 패턴을 통째로 뺀 검증(38개 샘플)의 분위수에서 정했다: 중앙값 아래는 0.05 이하,
# 상위 25%가 0.44 이상, 상위 5%가 1.15 이상이다.
SIGMA_CAUTION = 0.45
SIGMA_LOW = 1.15
INTERVAL_K = 3.0       # 90% 구간 = 보정값 +- INTERVAL_K x 퍼짐 (바닥 0.3도와 함께 쓰면 패턴을 통째로 뺀 검증에서 실제 포함 비율 약 0.95, 3 시그마만으로는 0.91. 계수를 검증 자료로 정했다)
INTERVAL_FLOOR = 0.3   # 퍼짐이 아주 작아도 구간 반폭은 이보다 작지 않게 한다(도)
NOVELTY_FAR = 1.23     # 샘플 새로움 거리(조건 서술 벡터)가 이보다 멀면 "먼 조건"(상위 20%)


def describe(sample: dict) -> np.ndarray:
    """샘플 조건 서술 벡터: 팬 8개, 줄 전력/10 6개, 제거한 랙 수."""
    return np.array([sample["fan"][f"CRAC_{i + 1:02d}"] for i in range(8)] + [p / 10.0 for p in sample["row_power_kw"]] + [float(len(sample.get("remove", [])))])


@dataclass
class Prediction:
    corrected: dict[str, float]            # 랙 이름 -> 보정한 입구 온도(되돌렸으면 우리 솔버 값 그대로)
    sigma: dict[str, float]                # 앙상블 퍼짐(되돌렸으면 NaN)
    lower90: dict[str, float]
    upper90: dict[str, float]
    level: dict[str, str]                  # ok / caution / low / fallback
    novelty: float                         # 가장 가까운 학습 샘플까지 거리(되돌렸으면 NaN)
    novelty_far: bool
    fallback: bool                         # True면 보정하지 않고 우리 솔버 값 그대로
    reason: str = ""
    correction: dict[str, float] = field(default_factory=dict)


class ResidualPredictor:
    def __init__(self, n_estimators: int = 200, min_samples_leaf: int = 3, seed: int = 0):
        self.n_estimators, self.min_samples_leaf, self.seed = n_estimators, min_samples_leaf, seed
        self.model: ExtraTreesRegressor | None = None
        self.geo = rm.load_geometry()
        self.train_desc: np.ndarray | None = None
        self.power_range = (0.0, 0.0)
        self.max_removed = 0
        self.rack_names = set(self.geo.names)

    # ------------------------------------------------------------------ 학습
    def fit(self, train_data: list[dict], specs: dict[str, dict]) -> "ResidualPredictor":
        """train_data: rm.load_dataset의 항목들(학습 샘플), specs: 샘플 id -> 샘플 명세."""
        X = np.vstack([d["X"] for d in train_data])
        y = np.concatenate([d["of"] - d["ours"] for d in train_data])
        self.model = ExtraTreesRegressor(n_estimators=self.n_estimators, min_samples_leaf=self.min_samples_leaf, random_state=self.seed, n_jobs=-1).fit(X, y)
        self.train_desc = np.array([describe(specs[d["id"]]) for d in train_data])
        powers = [p for d in train_data for p in specs[d["id"]]["row_power_kw"]]
        self.power_range = (float(min(powers)), float(max(powers)))
        self.max_removed = int(max(len(specs[d["id"]].get("remove", [])) for d in train_data))
        return self

    # ------------------------------------------------------------------ 안전장치
    def out_of_range_reason(self, sample: dict) -> str:
        lo, hi = self.power_range
        margin = 1.0
        if any(p < lo - margin or p > hi + margin for p in sample["row_power_kw"]):
            return f"줄 전력이 학습 범위({lo:g}~{hi:g} kW) 밖"
        # 학습 샘플은 줄 안의 랙 전력이 모두 같다. 줄 평균이 범위 안이어도 랙 하나가 범위 밖이면(예: 한 랙만 3배) 배운 적 없는 조건이다(docs/30 H3).
        # 랙별 전력은 넣는 쪽이 줄 때만 본다(L2 서버가 준다. 샘플 명세로 부르는 검증 코드는 줄 평균만 준다)
        rack = sample.get("rack_power_kw") or {}
        bad = sorted(n for n, p in rack.items() if p < lo - margin or p > hi + margin)
        if bad:
            return f"랙 전력이 학습 범위({lo:g}~{hi:g} kW) 밖: {', '.join(bad[:3])}{' 외' if len(bad) > 3 else ''}"
        if any(not (0.0 <= f <= 1.0) for f in sample["fan"].values()):
            return "팬 레벨이 0~1 밖"
        if len(sample.get("remove", [])) > self.max_removed:
            return f"제거한 랙이 학습 최대({self.max_removed}기)보다 많음"
        if any(n not in self.rack_names for n in sample.get("remove", [])):
            return "장면에 없는 랙을 제거"
        return ""

    # ------------------------------------------------------------------ 예측
    def predict(self, sample: dict, ours: dict[str, float], ours_info: dict, enforce_range: bool = True) -> Prediction:
        """enforce_range=False는 검증용이다(범위 밖이어도 보정하되 reason에 사유를 남긴다). 실제 사용에서는 True로 둔다."""
        assert self.model is not None, "fit 또는 load를 먼저 한다"
        reason = self.out_of_range_reason(sample)
        if reason and enforce_range:
            nan = float("nan")
            names = [n for n in ours if n not in set(sample.get("remove", []))]
            return Prediction(
                corrected={n: ours[n] for n in names}, sigma={n: nan for n in names},
                lower90={n: ours[n] for n in names}, upper90={n: ours[n] for n in names},
                level={n: "fallback" for n in names}, novelty=nan, novelty_far=True, fallback=True, reason=reason,
            )
        X, o, names = rm.sample_features(self.geo, sample, ours, ours_info)
        per_tree = np.stack([t.predict(X) for t in self.model.estimators_])
        corr, sig = per_tree.mean(0), per_tree.std(0)
        half = np.maximum(INTERVAL_K * sig, INTERVAL_FLOOR)
        level = np.where(sig >= SIGMA_LOW, "low", np.where(sig >= SIGMA_CAUTION, "caution", "ok"))
        nov = float(np.min(np.linalg.norm(self.train_desc - describe(sample), axis=1)))
        val = o + corr
        return Prediction(
            corrected=dict(zip(names, val.tolist())), sigma=dict(zip(names, sig.tolist())),
            lower90=dict(zip(names, (val - half).tolist())), upper90=dict(zip(names, (val + half).tolist())),
            level=dict(zip(names, level.tolist())), novelty=nov, novelty_far=nov > NOVELTY_FAR, fallback=False,
            correction=dict(zip(names, corr.tolist())), reason=reason,
        )

    # ------------------------------------------------------------------ 저장과 불러오기(모델 파일은 저장소에 올리지 않는다)
    def save(self, path: Path) -> None:
        with open(path, "wb") as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path: Path) -> "ResidualPredictor":
        with open(path, "rb") as f:
            obj = pickle.load(f)  # 신뢰할 수 있는 우리 파일만 읽는다(pickle은 다른 사람이 만든 파일을 열면 위험하다)
        return obj
