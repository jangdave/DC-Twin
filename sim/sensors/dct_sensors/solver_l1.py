"""L1 모델: Warp 열 시뮬레이션(`experiments/omniverse_probe/hall60_sim.py`)의 결과를 센서 앵커 위치에서 읽는다.

Warp와 USD(pxr)가 있는 환경에서만 쓴다. 예(저장소 루트에서):

    cd experiments/omniverse_probe
    set PYTHONPATH=..\\..\\sim\\sensors      (PowerShell: $env:PYTHONPATH = "..\\..\\sim\\sensors")
    uv run --python 3.13 python -m dct_sensors --manifest ..\\..\\sim\\out\\sensor_manifest.json --scenario cooling_failure --solver l1 --time-scale 0 --out ..\\..\\sim\\out\\recordings\\cooling_failure_l1.jsonl

- 공기 흐름은 CRAC 팬 상태가 바뀔 때 다시 푼다(몇 초 걸림). 온도 계산은 매 단계 Warp로 한다.
- 랙 입구, 출구 온도는 장면의 센서 앵커 위치에서 읽고, CRAC 회수 온도는 회수면 칸들의 평균이다.
  CRAC 공급 온도는 계산하지 않고 `급기 온도 + crac_supply_rise x (1 - 팬 비율)`로 만든다(L0와 같은 식).
- 응답 속도는 hall60_sim의 `slow`(기본 10)로 늦춘다. 측정값이 아니라 조절값이다.
- 시작할 때 `warmup_s`(기본 120초) 동안 정상 상태로 예열한 뒤부터 값을 내보낸다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from .config import Config
from .manifest import Manifest
from .solvers import Controls

REPO = Path(__file__).resolve().parents[3]


class L1Solver:
    def __init__(self, manifest: Manifest, cfg: Config, scene: str | None = None, slow: float = 10.0, warmup_s: float = 120.0):
        sys.path.insert(0, str(REPO / "experiments" / "omniverse_probe"))
        try:
            import warp as wp
            import hall60_sim as hs
        except ImportError as exc:
            raise SystemExit(f"L1에는 Warp와 USD가 필요하다(experiments/omniverse_probe 환경에서 실행): {exc}") from exc
        self.hs, self.cfg, self.m = hs, cfg, manifest
        wp.config.quiet = True
        wp.init()
        hall = hs.read_hall(Path(scene) if scene else REPO / "usd" / "scenes" / "hall01.usda")
        self.lay = hs.Layout(hall)
        self.sim = hs.Sim(hall, self.lay, cfg.power_ref, slow, t_supply=cfg.t_supply)
        self.rack_names = [r["name"].lower() for r in hall["racks"]]
        self.crac_names = [c["name"].lower() for c in hall["cracs"]]
        if set(self.rack_names) != set(manifest.rack_names) or set(self.crac_names) != set(manifest.cracs):
            raise SystemExit("매니페스트와 장면의 랙, CRAC 이름이 다르다")
        self.anchors, self.keys = [], []
        for a in hall["anchors"]:
            eq = a["equipment"].lower()
            if eq in self.rack_names and a["metric"] in ("temp_in", "temp_out"):
                self.anchors.append(a)
                self.keys.append(f"{eq}/{a['metric']}")
        self.fan = np.ones(len(self.crac_names), dtype=np.float32)
        self.sim.set_fans(self.fan)
        self.flow_solves = 1
        self.steps_per_tick = max(1, int(round(cfg.interval_s / self.sim.dt_phys)))
        self.ret_cells = [np.argwhere(self.lay.ret_id == i) for i in range(len(self.crac_names))]
        self._power = None
        for _ in range(int(warmup_s / self.sim.dt_phys)):  # 초기 온도(24도)에서 정상 상태로 예열한다(센서 값은 내보내지 않음)
            self.sim.step()

    def set_supply(self, value: float) -> None:
        """급기 온도를 바꾼다. Warp 계산이 다음 단계부터 새 값을 쓴다(공기가 새 온도로 서서히 바뀐다)."""
        self.sim.t_supply = float(value)

    def step(self, dt: float, controls: Controls) -> dict[str, float]:
        fan = np.array([controls.fan.get(c, 1.0) for c in self.crac_names], dtype=np.float32)
        if not np.array_equal(fan, self.fan):  # 팬 상태가 바뀌면 흐름을 다시 푼다
            self.fan = fan
            self.sim.set_fans(fan)
            self.flow_solves += 1
        power = np.array([controls.power.get(r, self.cfg.power_ref) for r in self.rack_names], dtype=np.float32)
        if self._power is None or not np.array_equal(power, self._power):
            self.sim.set_power(power)
            self._power = power
        for _ in range(max(1, int(round(dt / self.sim.dt_phys)))):
            self.sim.step()
        vals = self.sim.sensors(self.anchors)
        out = {k: float(v) for k, v in zip(self.keys, vals)}
        T = self.sim.T.numpy()
        for i, c in enumerate(self.crac_names):
            cells = self.ret_cells[i]
            out[f"{c}/return_temp"] = float(T[cells[:, 0], cells[:, 1], cells[:, 2]].mean()) if len(cells) else self.cfg.t_supply
            out[f"{c}/supply_temp"] = self.cfg.t_supply + self.cfg.crac_supply_rise * (1.0 - float(fan[i]))
        return out
