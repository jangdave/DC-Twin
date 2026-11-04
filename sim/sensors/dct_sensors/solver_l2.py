"""L2 모델: L1(Warp 열 시뮬레이션)의 랙 입구 온도에 OpenFOAM 기준 답으로 배운 보정을 더하고, 90% 구간과 신뢰 등급을 붙인다.

보정 모델은 `experiments/surrogate_model/predictor.py`의 `ResidualPredictor`다(근거와 한계: `experiments/results/E5_surrogate_residual_model.md`).
`model.pkl`이 있으면 읽고, 없으면 저장소의 OpenFOAM 학습 결과로 몇 초 안에 학습한다. scikit-learn과 Warp가 있는 환경에서 쓴다:

    cd experiments/omniverse_probe
    uv run --python 3.13 python -m dct_sensors --manifest ../../sim/out/sensor_manifest.json --scenario cooling_failure --solver l2 --time-scale 0 --out ../../sim/out/recordings/cooling_failure_l2.jsonl

동작
- 랙 입구(temp_in) 값만 보정한다. 출구, CRAC 온도, 전력, 팬 속도는 L1 그대로다.
- 매 단계의 조건(CRAC 팬 비율, 줄별 평균 전력)과 L1의 입구 온도, L1이 낸 유량 정보를 예측기에 넣는다.
- 보정 모델은 **정상 상태**(고장을 건 뒤 충분히 지난 값)로 배웠다. 시나리오가 바뀐 직후의 천천히 변하는 구간에서는 L1 값이 아직 정상 상태가 아니므로,
  그 값을 그대로 입력으로 쓴다. 보정량도 그에 맞춰 조금씩 변한다. 이 구간의 정확도는 따로 검증하지 않았다.
- 보정량(L2 - L1)은 시간 상수 `tau_s`(설정)의 1차 지연으로 바꾼다. 안 그러면 조건이 바뀐 순간 보정량이 한 번에 뛰어(실제로 고장 시점에 최고 입구 온도가 1초 만에 약 5도 올랐다) 온도가 순간이동한다.
- `estimates`에 센서 키별 `lower`, `upper`(90% 구간), `confidence`(ok, caution, low)를 둔다. 조건이 학습 범위 밖이면 L1 값을 그대로 쓰고 confidence를 `fallback`으로 한다.
- 시각화 목적이며 공학적 정확성을 주장하지 않는다. 보정은 OpenFOAM 10 cm 격자 결과를 흉내 낼 뿐이다.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from .config import Config
from .manifest import Manifest
from .solvers import Controls

REPO = Path(__file__).resolve().parents[3]
SURROGATE_DIR = REPO / "experiments" / "surrogate_model"


def load_default_predictor():
    """model.pkl을 읽거나, 없으면 저장소의 학습 결과로 학습한다."""
    sys.path.insert(0, str(SURROGATE_DIR))
    try:
        import predictor as pr
        import residual_model as rm
    except ImportError as exc:
        raise SystemExit(f"L2에는 scikit-learn이 필요하다(experiments/omniverse_probe 환경에서 실행): {exc}") from exc
    pkl = SURROGATE_DIR / "model.pkl"
    if pkl.exists():
        return pr.ResidualPredictor.load(pkl)
    import json

    samples_json = rm.BASE / "surrogate" / "samples.json"
    specs = {s["id"]: s for s in json.loads(samples_json.read_text(encoding="utf-8"))["samples"]}
    data = [d for d in rm.load_dataset(rm.RES / "surrogate", samples_json, False) if not d["holdout"]]
    return pr.ResidualPredictor().fit(data, specs)


def rack_title(name: str) -> str:
    """`rack_01` -> `Rack_01` (장면의 이름)."""
    return "Rack_" + name.split("_", 1)[1]


class L2Solver:
    def __init__(self, manifest: Manifest, cfg: Config, base=None, predictor=None, **kw):
        if base is None:
            from .solver_l1 import L1Solver

            base = L1Solver(manifest, cfg, **kw)
        self.base, self.m, self.cfg = base, manifest, cfg
        self.predictor = predictor if predictor is not None else load_default_predictor()
        self.estimates: dict[str, dict] = {}
        self._corr: dict[str, float] = {}   # 센서 키 -> 지연을 거친 보정량
        self.fallback_steps = 0
        self.last_reason = ""

    def controls_changed(self) -> None:
        if hasattr(self.base, "controls_changed"):
            self.base.controls_changed()

    def sample_of(self, controls: Controls) -> dict:
        """샘플 명세(예측기 입력): CRAC 팬 비율과 줄별 평균 전력."""
        n_rows = max(row for row, _ in self.m.racks.values())
        per_row: list[list[float]] = [[] for _ in range(n_rows)]
        for name, (row, _) in self.m.racks.items():
            per_row[row - 1].append(controls.power.get(name, self.cfg.power_ref))
        return {
            "fan": {f"CRAC_{c.split('_')[1]}": float(controls.fan.get(c, 1.0)) for c in self.m.cracs},
            "row_power_kw": [sum(v) / len(v) if v else self.cfg.power_ref for v in per_row],
            "remove": [],
        }

    def step(self, dt: float, controls: Controls) -> dict[str, float]:
        out = self.base.step(dt, controls)
        info = getattr(getattr(self.base, "sim", None), "flow_info", None) or getattr(self.base, "flow_info", None)
        # 보정 모델은 기준 급기 온도(t_supply_ref)에서 배웠다. 급기가 다르면 L1 값에서 그 차이만큼 빼서 넣고, 결과에 다시 더한다(식이 선형이라는 가정).
        shift = self.cfg.t_supply - self.cfg.t_supply_ref
        ours = {rack_title(n): out[f"{n}/temp_in"] - shift for n in self.m.rack_names if f"{n}/temp_in" in out}
        info = {"supply_m3s": float(info["supply_m3s"]), "aisle_leak_m3s": [float(x) for x in info["aisle_leak_m3s"]]}
        r = self.predictor.predict(self.sample_of(controls), ours, info)
        self.last_reason = r.reason
        self.estimates = {}
        if r.fallback:
            self.fallback_steps += 1
        alpha = 1.0 - math.exp(-dt / self.cfg.tau_s)
        for n in self.m.rack_names:
            key = f"{n}/temp_in"
            t = rack_title(n)
            if key not in out or t not in r.corrected:
                continue
            base = ours[t] + shift
            target = float(r.corrected[t]) - ours[t]
            prev = self._corr.get(key)  # 처음에는 목표 보정량으로 시작한다(예열 구간을 따로 두지 않는다)
            cur = target if prev is None else prev + (target - prev) * alpha
            self._corr[key] = cur
            val = base + cur
            out[key] = val
            self.estimates[key] = {"lower": round(val - (float(r.corrected[t]) - float(r.lower90[t])), 3),
                                   "upper": round(val + (float(r.upper90[t]) - float(r.corrected[t])), 3), "confidence": r.level[t]}
        return out
