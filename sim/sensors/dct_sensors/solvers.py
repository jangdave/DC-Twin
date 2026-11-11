"""온도 모델. L0는 간단한 1차 지연 모델(기준선이자 대체 수단), L1은 Warp 열 시뮬레이션(`solver_l1.py`).

두 모델은 같은 인터페이스를 쓴다: `step(dt, controls) -> {센서 키: 값}`. 센서 키는 `rack_01/temp_in`처럼 주소의 뒷부분이다.
교육·시각화용이며 실제 열역학 해석이 아니다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .config import Config
from .manifest import Layout, Manifest


@dataclass
class Controls:
    """한 시점의 제어 값. 시나리오 이벤트로 바뀐다."""

    fan: dict[str, float] = field(default_factory=dict)    # crac_01 -> 0~1
    power: dict[str, float] = field(default_factory=dict)  # rack_01 -> kW


class L0Solver:
    """냉각이 줄면 입구 온도의 목표값이 오르고, 온도는 목표값을 향해 1차 지연으로 변한다.

    - 담당 줄의 냉각 비율 f = 그 열기 통로를 맡은 CRAC 팬 비율의 평균
    - 입구 목표 = 급기 온도 + 기본 상승 + recirc_gain x (1 - f) x (전력 / 기준 전력) x 줄 끝 보정 + 전력이 기준의 80%를 넘는 만큼의 상승
    - 출구 = 입구 + outlet_dt_ref x (전력 / 기준 전력) / (0.5 + 0.5 f)   (냉각이 줄면 공기량이 줄어 온도 차가 커진다)
    - CRAC 공급 온도 = 급기 온도 + crac_supply_rise x (1 - 팬 비율), 회수 온도 = 담당 줄 랙 출구 평균 + return_offset
    """

    def __init__(self, manifest: Manifest, cfg: Config):
        self.m, self.cfg = manifest, cfg
        self.layout = Layout.from_manifest(manifest)
        per_row: dict[int, list[str]] = {}
        for name, (row, _) in manifest.racks.items():
            per_row.setdefault(row, []).append(name)
        self.row_of = {n: manifest.racks[n][0] for n in manifest.racks}
        self.end_rack: set[str] = set()
        for row, names in per_row.items():
            names.sort(key=lambda n: manifest.racks[n][1])
            self.end_rack.update((names[0], names[-1]))
        self.inlet = {n: cfg.t_supply + cfg.inlet_base_rise for n in manifest.racks}
        self.outlet = {n: self.inlet[n] + cfg.outlet_dt_ref * 0.7 for n in manifest.racks}
        self.crac_aisle = {c: self.layout.aisle_of_crac(int(c.split("_")[1])) for c in manifest.cracs}

    def cooling_fraction(self, aisle: int, controls: Controls) -> float:
        names = [f"crac_{n:02d}" for n in self.layout.cracs_for_aisle(aisle)]
        vals = [controls.fan.get(n, 1.0) for n in names if n in self.m.cracs]
        return sum(vals) / len(vals) if vals else 1.0

    def step(self, dt: float, controls: Controls) -> dict[str, float]:
        cfg = self.cfg
        alpha = 1.0 - math.exp(-dt / cfg.tau_s)
        out: dict[str, float] = {}
        row_out: dict[int, list[float]] = {}
        for n in self.m.rack_names:
            aisle = self.layout.aisle_of_row(self.row_of[n])
            f = self.cooling_fraction(aisle, controls)
            p = controls.power.get(n, cfg.power_ref)
            end = cfg.end_rack_factor if n in self.end_rack else 1.0
            target = (cfg.t_supply + cfg.inlet_base_rise + cfg.recirc_gain * (1.0 - f) * (p / cfg.power_ref) * end
                      + cfg.inlet_power_coeff * max(0.0, p / cfg.power_ref - 0.8))
            self.inlet[n] += (target - self.inlet[n]) * alpha
            target_out = self.inlet[n] + cfg.outlet_dt_ref * (p / cfg.power_ref) / (0.5 + 0.5 * f)
            self.outlet[n] += (target_out - self.outlet[n]) * alpha
            out[f"{n}/temp_in"], out[f"{n}/temp_out"] = self.inlet[n], self.outlet[n]
            row_out.setdefault(aisle, []).append(self.outlet[n])
        for c in self.m.cracs:
            a = self.crac_aisle[c]
            fan = controls.fan.get(c, 1.0)
            vals = row_out.get(a, [self.inlet_mean()])
            out[f"{c}/supply_temp"] = cfg.t_supply + cfg.crac_supply_rise * (1.0 - fan)
            out[f"{c}/return_temp"] = float(np.mean(vals)) + cfg.return_offset
        return out

    def inlet_mean(self) -> float:
        return float(np.mean(list(self.inlet.values())))


def make_solver(name: str, manifest: Manifest, cfg: Config, **kw):
    if name == "l0":
        return L0Solver(manifest, cfg)
    if name == "l1":
        from .solver_l1 import L1Solver  # Warp가 필요해서 필요할 때만 가져온다

        return L1Solver(manifest, cfg, **kw)
    if name == "l2":
        from .solver_l2 import L2Solver  # L1에 OpenFOAM으로 배운 보정을 더한다(scikit-learn 필요)

        return L2Solver(manifest, cfg, **kw)
    raise SystemExit(f"알 수 없는 solver: {name} (l0, l1, l2)")
