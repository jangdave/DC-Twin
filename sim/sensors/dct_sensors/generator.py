"""센서 값 생성 반복문. 시나리오 이벤트를 적용하고, 모델로 값을 만들고, 잡음과 품질, 알람을 붙여 내보낸다.

내보내는 줄(한 줄에 하나, `.jsonl`)의 종류 (11 데이터 규격 4장, 5장):
- `{"type":"scenario","event":"start"|"end","name":...,"ts":...}`
- `{"type":"sample","sensorId":...,"topic":...,"ts":...,"value":...,"unit":...,"quality":"good|bad"}`   (MQTT 페이로드 + 주소)
  L2 모델이 보정한 센서에는 선택 필드 `lower`, `upper`(90% 구간), `confidence`(ok|caution|low|fallback)가 붙는다.
- `{"type":"alarm","sensorId":...,"from":...,"to":...,"value":...,"ts":...}`
- `{"type":"aggregate","name":...,"value":...,"unit":...,"ts":...}`  (집계. 게이트웨이가 만드는 값의 기준 구현, MQTT로는 보내지 않음)

난수는 시드를 받아 같은 시드, 같은 시나리오, 같은 설정이면 같은 값이 나온다.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np

from .alarms import AlarmState, quality_for
from .config import Config
from .manifest import Manifest
from .scenarios import Scenario
from .solvers import Controls

FAULT_RE = re.compile(r"^dropout:(?P<id>[A-Z0-9-]+):(?P<dur>\d+(?:\.\d+)?)s(?:@(?P<at>\d+(?:\.\d+)?)s)?$")


@dataclass(frozen=True)
class Dropout:
    sensor_id: str
    start: float
    duration: float

    def active(self, t: float) -> bool:
        return self.start <= t < self.start + self.duration


def parse_fault(text: str, default_start: float = 10.0) -> Dropout:
    """`dropout:H01-RK05-TEMP-IN:30s` 또는 `dropout:H01-RK05-TEMP-IN:30s@45s`(45초에 시작)."""
    m = FAULT_RE.match(text)
    if not m:
        raise SystemExit(f"고장 주입 형식이 올바르지 않다: {text} (예: dropout:H01-RK05-TEMP-IN:30s@45s)")
    return Dropout(m.group("id"), float(m.group("at")) if m.group("at") else default_start, float(m.group("dur")))


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


class Generator:
    def __init__(self, manifest: Manifest, scenario: Scenario, solver, cfg: Config, seed: int = 1, faults: list[Dropout] | None = None):
        self.m, self.sc, self.solver, self.cfg = manifest, scenario, solver, cfg
        self.rng = np.random.default_rng(seed)
        self.faults = faults or []
        for f in self.faults:
            if f.sensor_id not in manifest.by_id:
                raise SystemExit(f"고장 주입 대상 센서가 없다: {f.sensor_id}")
        self.t0 = dt.datetime.fromisoformat(cfg.start_ts.replace("Z", "+00:00"))
        # 랙마다 기본 전력과 오르내림 위상(시드에서)
        n = len(manifest.rack_names)
        self.base_power = {r: float(self.rng.uniform(cfg.power_base_min, cfg.power_base_max)) for r in manifest.rack_names}
        self.phase = {r: float(self.rng.uniform(0, 2 * math.pi)) for r in manifest.rack_names}
        self.fan_ctl = {c: 1.0 for c in manifest.cracs}
        self.power_scale = {r: 1.0 for r in manifest.rack_names}
        self.alarms = {s.sensor_id: AlarmState(s.warn, s.critical, s.direction, cfg.hysteresis, cfg.consecutive) for s in manifest.sensors}
        self._fired: set[int] = set()
        self.energy_kwh = 0.0
        self.t_now = 0.0

    # ---- 시나리오 이벤트 ----
    def _targets(self, target: str) -> list[str]:
        if target.startswith("row:"):
            row = int(target.split(":")[1])
            return [r for r, (rw, _) in self.m.racks.items() if rw == row]
        return [target]

    def apply_control(self, kind: str, target: str, value: float) -> dict:
        """제어 하나를 바로 적용하고 이벤트 줄(`scenario` 종류 `event`)을 돌려준다. 시나리오 이벤트와 서버의 직접 조작이 같이 쓴다.

        대상이 없으면 `SystemExit`(시나리오 정의 오류)가 아니라 `ValueError`를 던진다. 서버가 잘못된 조작을 거절할 때 쓴다.
        """
        if kind == "crac_fan":
            if target not in self.fan_ctl:
                raise ValueError(f"대상 CRAC가 매니페스트에 없다: {target}")
            self.fan_ctl[target] = value
        elif kind == "rack_power_scale":
            targets = self._targets(target)
            if not targets or any(r not in self.power_scale for r in targets):
                raise ValueError(f"대상 랙이 매니페스트에 없다: {target}")
            for r in targets:
                self.power_scale[r] = value
        else:
            raise ValueError(f"알 수 없는 제어 종류: {kind}")
        if hasattr(self.solver, "controls_changed"):
            self.solver.controls_changed()
        return {"type": "scenario", "event": "event", "name": self.sc.name, "kind": kind, "target": target, "value": value, "t": self.t_now}

    def _apply_events(self, t: float) -> Iterator[dict]:
        self.t_now = t
        for i, e in enumerate(self.sc.events):
            if i in self._fired or t < e.t:
                continue
            self._fired.add(i)
            try:
                ev = self.apply_control(e.kind, e.target, e.value)
            except ValueError as exc:
                raise SystemExit(f"시나리오 정의 오류: {exc}") from None
            ev["t"] = e.t
            yield ev

    def controls(self, t: float) -> Controls:
        cfg = self.cfg
        power = {}
        for r in self.m.rack_names:
            wob = cfg.power_wobble * math.sin(2 * math.pi * t / cfg.power_period_s + self.phase[r])
            power[r] = max(0.0, (self.base_power[r] + wob) * self.power_scale[r])
        return Controls(dict(self.fan_ctl), power)

    # ---- 한 단계 ----
    def step(self, t: float) -> Iterator[dict]:
        cfg = self.cfg
        ts = iso(self.t0 + dt.timedelta(seconds=t))
        yield from ({**ev, "ts": ts} for ev in self._apply_events(t))
        ctl = self.controls(t)
        temps = self.solver.step(cfg.interval_s, ctl)
        estimates = getattr(self.solver, "estimates", None) or {}  # L2: 센서 키 -> {lower, upper, confidence}
        it_power = 0.0
        fan_sum = 0.0
        for s in self.m.sensors:
            if s.metric == "power" and s.equipment_type == "rack":
                v = max(0.0, ctl.power[s.equipment] + self.rng.normal(0, cfg.noise_power))  # 잡음으로 음수가 되지 않게
                it_power += ctl.power[s.equipment]
            elif s.metric == "fan_speed":
                v = ctl.fan[s.equipment] * 100.0 + self.rng.normal(0, cfg.noise_fan)
                v = min(max(v, s.value_range[0]), s.value_range[1])  # 팬 속도는 0~100%를 넘지 않는다(잡음 때문에 100.2%가 되면 bad로 판정되던 것)
                fan_sum += ctl.fan[s.equipment]
            else:
                if s.key not in temps:
                    continue
                v = temps[s.key] + self.rng.normal(0, cfg.noise_temp)
            if any(f.sensor_id == s.sensor_id and f.active(t) for f in self.faults):
                continue  # 고장 주입: 값을 보내지 않는다(게이트웨이가 5초 뒤 stale로 본다)
            v = float(round(v, 3))
            q = quality_for(v, s.value_range)
            msg = {"type": "sample", "sensorId": s.sensor_id, "topic": s.topic, "ts": ts, "value": v, "unit": s.unit, "quality": q}
            if s.key in estimates:
                msg.update(estimates[s.key])
            yield msg
            if q == "good":
                tr = self.alarms[s.sensor_id].update(v)
                if tr:
                    yield {"type": "alarm", "sensorId": s.sensor_id, "from": tr[0], "to": tr[1], "value": v, "ts": ts}
            else:
                self.alarms[s.sensor_id].break_run()
        # 집계(11 데이터 규격 9장): 합성 추정
        n_crac = len(self.m.cracs)
        cooling = n_crac * cfg.cooling_base_kw + cfg.fan_power_kw * fan_sum
        facility = it_power + cooling + it_power * cfg.loss_ratio
        self.energy_kwh += facility * cfg.interval_s / 3600.0
        for name, val, unit in (("it_power", it_power, "kW"), ("cooling_power", cooling, "kW"), ("facility_power", facility, "kW"),
                                ("pue", facility / it_power if it_power > 0 else 0.0, ""), ("energy_kwh", self.energy_kwh, "kWh")):
            yield {"type": "aggregate", "name": name, "value": round(val, 4), "unit": unit, "ts": ts}

    def run(self, duration_s: float) -> Iterator[dict]:
        yield {"type": "scenario", "event": "start", "name": self.sc.name, "ts": iso(self.t0)}
        steps = int(duration_s / self.cfg.interval_s)
        for i in range(steps):
            yield from self.step(i * self.cfg.interval_s)
        yield {"type": "scenario", "event": "end", "name": self.sc.name, "ts": iso(self.t0 + dt.timedelta(seconds=steps * self.cfg.interval_s))}
