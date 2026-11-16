"""센서 값 생성기 실행.

    uv run python -m dct_sensors --manifest ../out/sensor_manifest.json --scenario cooling_failure --duration 300 --time-scale 0 --out ../out/recordings/cooling_failure.jsonl

- `--time-scale`: 1이면 실시간, 10이면 10배 빠르게, 0이면 기다리지 않고 가능한 한 빠르게(녹화, 시험용)
- `--solver l0|l1|l2`: l0는 간단한 모델, l1은 Warp 열 시뮬레이션(Warp가 있는 환경에서만, `docs/11` 6.2장),
  l2는 l1에 OpenFOAM으로 배운 보정을 더하고 랙 입구 온도에 95% 구간과 신뢰 등급을 붙인다(scikit-learn도 필요, `solver_l2.py`)
- `--fault dropout:H01-RK05-TEMP-IN:30s@45s`: 45초부터 30초 동안 그 센서 값을 보내지 않는다(여러 번 쓸 수 있음)
- `--out`을 생략하면 표준 출력으로 한 줄씩 내보낸다. `--mqtt host:port`를 주면 MQTT로도 보낸다(샘플만).
"""
from __future__ import annotations

import argparse
import collections
import sys

from .config import Config
from .generator import Generator, parse_fault
from .manifest import load_manifest
from .publish import JsonlPublisher, MqttPublisher, Pacer
from .scenarios import SCENARIOS, get
from .solvers import make_solver


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dct_sensors", description="DC-Twin 센서 값 생성기")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--scenario", default="normal", choices=sorted(SCENARIOS))
    ap.add_argument("--duration", type=float, default=300.0, help="시뮬레이션 시간(초)")
    ap.add_argument("--solver", default="l0", choices=["l0", "l1", "l2"])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--time-scale", type=float, default=1.0)
    ap.add_argument("--config", default=None, help="매개변수를 덮어쓰는 JSON")
    ap.add_argument("--fault", action="append", default=[])
    ap.add_argument("--out", default=None, help=".jsonl 파일. 생략하면 표준 출력")
    ap.add_argument("--mqtt", default=None, help="host:port. 샘플을 MQTT로도 보낸다")
    ap.add_argument("--quiet", action="store_true", help="끝날 때 요약을 출력하지 않는다")
    ap.add_argument("--scene", default=None, help="(l1) 홀 장면 USD 경로")
    args = ap.parse_args(argv)

    cfg = Config.load(args.config)
    m = load_manifest(args.manifest)
    kw = {"scene": args.scene} if args.solver in ("l1", "l2") and args.scene else {}
    solver = make_solver(args.solver, m, cfg, **kw)
    gen = Generator(m, get(args.scenario), solver, cfg, seed=args.seed, faults=[parse_fault(f) for f in args.fault])
    sinks = [JsonlPublisher(args.out)]
    if args.mqtt:
        host, _, port = args.mqtt.partition(":")
        sinks.append(MqttPublisher(host, int(port or 1883)))
    pacer = Pacer(cfg.interval_s, args.time_scale)
    counts: collections.Counter = collections.Counter()
    alarms = []
    last_ts = None
    try:
        for msg in gen.run(args.duration):
            for s in sinks:
                s.send(msg)
            counts[msg["type"]] += 1
            if msg["type"] == "alarm":
                alarms.append(msg)
            if msg["ts"] != last_ts and msg["type"] == "sample":
                last_ts = msg["ts"]
                pacer.wait()
    finally:
        for s in sinks:
            s.close()
    if not args.quiet:
        err = sys.stderr
        print(f"[생성기] 시나리오 {args.scenario}, {args.duration:.0f}초, solver {args.solver}, 시드 {args.seed}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())), file=err)
        for a in alarms[:12]:
            print(f"  알람 {a['ts']} {a['sensorId']} {a['from']} -> {a['to']} ({a['value']})", file=err)
        if len(alarms) > 12:
            print(f"  ... 알람 {len(alarms)}건", file=err)
    return 0


if __name__ == "__main__":
    sys.exit(main())
