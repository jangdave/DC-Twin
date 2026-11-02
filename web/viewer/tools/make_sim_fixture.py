"""브라우저 간이 시뮬레이션(JS)이 센서 생성기 L0 모델(파이썬)과 같은 값을 내는지 비교할 기준 자료를 만든다.

잡음을 0으로 하고 시나리오를 돌려서, 랙별 기본 전력과 위상(난수에서 나온 값)과 함께 일부 단계의 값을 저장한다.
JS 쪽은 같은 기본 전력과 위상을 넣어 같은 값이 나오는지 `test/sim.test.js`에서 확인한다.

    cd sim/sensors
    uv run --python 3.13 python ../../web/viewer/tools/make_sim_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "sim" / "sensors"))

from dct_sensors.config import Config  # noqa: E402
from dct_sensors.generator import Generator  # noqa: E402
from dct_sensors.manifest import load_manifest  # noqa: E402
from dct_sensors.scenarios import get  # noqa: E402
from dct_sensors.solvers import L0Solver  # noqa: E402

OUT = REPO / "web" / "viewer" / "test" / "fixtures" / "sim_l0.json"
STEPS = 200
EVERY = 10


def run(name: str, seed: int) -> dict:
    cfg = Config()
    cfg.noise_temp = cfg.noise_power = cfg.noise_fan = 0.0
    m = load_manifest(REPO / "sim" / "out" / "sensor_manifest.json")
    gen = Generator(m, get(name), L0Solver(m, cfg), cfg, seed=seed)
    by_id = {s.sensor_id: s for s in m.sensors}
    frames, alarms = [], []
    for i in range(STEPS):
        vals, agg = {}, {}
        for msg in gen.step(float(i)):
            if msg["type"] == "sample":
                vals[msg["sensorId"]] = msg["value"]
            elif msg["type"] == "alarm":
                alarms.append({"t": i, "sensorId": msg["sensorId"], "from": msg["from"], "to": msg["to"]})
            elif msg["type"] == "aggregate":
                agg[msg["name"]] = msg["value"]
        if i % EVERY == 0:
            frames.append({"t": i, "values": vals, "aggregates": agg})
    assert all(k in by_id for k in frames[0]["values"])
    return {
        "scenario": name,
        "basePower": gen.base_power,
        "phase": gen.phase,
        "config": cfg.to_dict(),
        "frames": frames,
        "alarms": alarms,
    }


def main() -> None:
    data = {"steps": STEPS, "every": EVERY, "runs": [run("cooling_failure", 7), run("power_spike", 11)]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT} {OUT.stat().st_size // 1024} KB, alarms {[len(r['alarms']) for r in data['runs']]}")


if __name__ == "__main__":
    main()
