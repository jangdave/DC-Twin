"""로컬 계산 서버: 센서 생성기를 실제 시간으로 돌리고 웹 보기 화면에 WebSocket으로 보낸다 (docs/21 4장).

게이트웨이와 같은 메시지(`snapshot`, `sample`, `alarm`, `aggregate`, `scenario`)를 보내고, 웹이 보내는 조작(`control`)을 받는다.
웹 보기 화면은 `?live=ws://127.0.0.1:8765/ws`로 붙는다. 이 컴퓨터에서만 쓰도록 만들었다.

    cd sim/sensors
    uv run --python 3.13 --extra serve python -m dct_sensors.serve --manifest ../out/sensor_manifest.json --solver l0

- `--solver l0|l1|l2`: 모델을 고른다. l1은 Warp, l2는 Warp와 scikit-learn이 필요하다(`experiments/omniverse_probe` 환경에서 실행).
  l2이면 랙 입구 온도 샘플에 `lower`, `upper`(90% 구간), `confidence`가 붙어 웹의 신뢰 막대가 나온다.
- 안전: 기본은 127.0.0.1에만 열고(`--allow-remote` 없이는 다른 주소로 열지 않는다), 웹 페이지의 출처(Origin)를 확인하고,
  접속 수와 조작 횟수와 메시지 크기를 제한한다. 조작은 허용한 종류와 장비 이름, 값 범위만 받는다.
- 시각화 목적이며 공학적 정확성을 주장하지 않는다.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import ipaddress
import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field

from .config import Config
from .generator import Generator, iso
from .manifest import Manifest, load_manifest
from .scenarios import SCENARIOS, get
from .solvers import make_solver

MAX_MESSAGE_BYTES = 1024          # 웹이 보내는 조작 한 건의 최대 크기
MAX_CLIENTS = 8
CONTROLS_PER_SECOND = 20          # 접속 하나가 초당 보낼 수 있는 조작 수
SPEED_RANGE = (0.5, 20.0)
POWER_RANGE = (0.0, 3.0)
DEFAULT_ORIGINS = [
    None,  # 브라우저가 아닌 클라이언트(시험 도구)
    re.compile(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$"),
    "https://jangdave.github.io",
]


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass
class State:
    """접속한 화면에 처음 보낼 전체 상태(snapshot)를 만들기 위한 마지막 값 모음."""

    manifest: Manifest
    scenario: str | None = None
    ts: str | None = None
    latest: dict = field(default_factory=dict)
    aggregates: dict = field(default_factory=dict)
    controls_fn: object = None  # 지금 조작 상태(팬 비율, 전력 배수)를 돌려주는 함수. 재접속한 화면의 슬라이더를 맞추는 데 쓴다

    def reset(self, scenario: str) -> None:
        self.scenario, self.ts = scenario, None
        self.latest.clear()
        self.aggregates.clear()

    def observe(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "sample":
            keep = {k: msg[k] for k in ("sensorId", "value", "unit", "quality", "ts", "lower", "upper", "confidence") if k in msg}
            keep["alarm"] = self.latest.get(msg["sensorId"], {}).get("alarm", "normal")
            self.latest[msg["sensorId"]] = keep
            self.ts = msg["ts"]
        elif t == "alarm":
            if msg["sensorId"] in self.latest:
                self.latest[msg["sensorId"]]["alarm"] = msg["to"]
        elif t == "aggregate":
            self.aggregates[msg["name"]] = {k: msg[k] for k in ("name", "value", "unit", "ts")}
        elif t == "scenario" and msg.get("event") == "start":
            self.reset(msg["name"])

    def snapshot(self) -> dict:
        sensors = [self.latest.get(s.sensor_id) or {"sensorId": s.sensor_id, "value": None, "unit": s.unit, "quality": "stale", "ts": None, "alarm": "normal"} for s in self.manifest.sensors]
        snap = {"type": "snapshot", "ts": self.ts, "scenario": self.scenario, "sensors": sensors, "aggregates": self.aggregates}
        if self.controls_fn:
            snap["controls"] = self.controls_fn()  # 게이트웨이에는 없는 추가 항목
        return snap


class Engine:
    """생성기와 모델을 들고, 한 단계 진행과 조작 적용을 한 번에 하나씩만 하도록 잠근다(진행은 다른 스레드에서 돈다)."""

    def __init__(self, manifest: Manifest, cfg: Config, solver_name: str, scenario: str, seed: int, solver_kw: dict | None = None):
        self.m, self.cfg, self.solver_name, self.seed = manifest, cfg, solver_name, seed
        self.solver_kw = solver_kw or {}
        self.lock = threading.Lock()
        self.state = State(manifest)
        self.solver = make_solver(solver_name, manifest, cfg, **self.solver_kw)
        self.gen: Generator | None = None
        self.t = 0.0
        self.state.controls_fn = self._controls
        self.start(scenario)

    def _controls(self) -> dict:
        g = self.gen
        return {"fan": dict(g.fan_ctl), "powerScale": dict(g.power_scale)} if g else {}

    def start(self, scenario: str) -> dict:
        """시나리오를 처음부터 시작한다. l0는 모델 상태도 새로 만들고, l1/l2는 열 상태를 이어 간다(제어만 처음으로)."""
        with self.lock:
            if self.solver_name == "l0":
                self.solver = make_solver("l0", self.m, self.cfg)
            self.gen = Generator(self.m, get(scenario), self.solver, self.cfg, seed=self.seed)
            self.t = 0.0
            msg = {"type": "scenario", "event": "start", "name": scenario, "ts": iso(self.gen.t0)}
            self.state.observe(msg)
            return msg

    def step(self) -> list[dict]:
        with self.lock:
            msgs = list(self.gen.step(self.t))
            self.t += self.cfg.interval_s
            for m in msgs:
                self.state.observe(m)
            return msgs

    def control(self, kind: str, target: str, value: float) -> dict:
        with self.lock:
            self.gen.t_now = self.t
            ev = self.gen.apply_control(kind, target, value)
            ev["ts"] = iso(self.gen.t0 + dt.timedelta(seconds=self.t))
            self.state.observe(ev)
            return ev


def validate_control(raw: str | bytes, manifest: Manifest) -> dict:
    """웹이 보낸 조작을 검사한다. 맞으면 {kind, ...} 사전, 틀리면 ValueError(이유는 화면에 그대로 보여 줘도 되는 문장)."""
    if len(raw) > MAX_MESSAGE_BYTES:
        raise ValueError("메시지가 너무 크다")
    try:
        d = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("JSON 형식이 아니다") from None
    if not isinstance(d, dict) or d.get("type") != "control":
        raise ValueError("control 메시지만 받는다")
    kind = d.get("kind")
    if kind == "crac_fan":
        target, value = d.get("target"), d.get("value")
        if target not in manifest.cracs:
            raise ValueError("알 수 없는 CRAC")
        if not _num(value) or not 0.0 <= value <= 1.0:
            raise ValueError("팬 속도는 0~1이어야 한다")
        return {"kind": kind, "target": target, "value": float(value)}
    if kind == "rack_power_scale":
        target, value = d.get("target"), d.get("value")
        row_ok = isinstance(target, str) and re.fullmatch(r"row:\d{2}", target) and 1 <= int(target[4:]) <= manifest.n_rows
        if not (target in manifest.racks or row_ok):
            raise ValueError("알 수 없는 랙이나 줄")
        if not _num(value) or not POWER_RANGE[0] <= value <= POWER_RANGE[1]:
            raise ValueError(f"전력 배수는 {POWER_RANGE[0]}~{POWER_RANGE[1]}이어야 한다")
        return {"kind": kind, "target": target, "value": float(value)}
    if kind == "scenario":
        name = d.get("name")
        if name not in SCENARIOS:
            raise ValueError("알 수 없는 시나리오")
        return {"kind": kind, "name": name}
    if kind == "speed":
        value = d.get("value")
        if not _num(value) or not SPEED_RANGE[0] <= value <= SPEED_RANGE[1]:
            raise ValueError(f"속도는 {SPEED_RANGE[0]}~{SPEED_RANGE[1]}배여야 한다")
        return {"kind": kind, "value": float(value)}
    raise ValueError("알 수 없는 조작 종류")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


class Server:
    def __init__(self, engine: Engine, speed: float = 1.0):
        self.engine = engine
        self.speed = speed
        self.clients: set = set()
        self._stop = asyncio.Event()

    async def ticker(self) -> None:
        import websockets

        loop = asyncio.get_running_loop()
        nxt = loop.time()
        while not self._stop.is_set():
            msgs = await loop.run_in_executor(None, self.engine.step)
            if self.clients:
                for m in msgs:
                    websockets.broadcast(self.clients, json.dumps(m, ensure_ascii=False, separators=(",", ":")))
            nxt += self.engine.cfg.interval_s / self.speed
            delay = nxt - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                nxt = loop.time()  # 계산이 느리면 따라잡으려 몰아서 보내지 않고 그 시점부터 다시 맞춘다

    async def handler(self, ws) -> None:
        import websockets

        if len(self.clients) >= MAX_CLIENTS:
            await ws.close(1013, "접속이 너무 많다")
            return
        self.clients.add(ws)
        loop = asyncio.get_running_loop()
        try:
            await ws.send(json.dumps(self.engine.state.snapshot(), ensure_ascii=False, separators=(",", ":")))
            window_start, count = loop.time(), 0
            async for raw in ws:
                now = loop.time()
                if now - window_start >= 1.0:
                    window_start, count = now, 0
                count += 1
                if count > CONTROLS_PER_SECOND:
                    await ws.send(json.dumps({"type": "error", "message": "조작이 너무 잦다"}))
                    continue
                try:
                    c = validate_control(raw if isinstance(raw, (bytes, str)) else "", self.engine.m)
                    if c["kind"] == "speed":
                        self.speed = c["value"]
                        continue
                    if c["kind"] == "scenario":
                        msgs = [await loop.run_in_executor(None, self.engine.start, c["name"])]
                    else:
                        msgs = [await loop.run_in_executor(None, self.engine.control, c["kind"], c["target"], c["value"])]
                except ValueError as exc:
                    await ws.send(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False))
                    continue
                for m in msgs:
                    websockets.broadcast(self.clients, json.dumps(m, ensure_ascii=False, separators=(",", ":")))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    def stop(self) -> None:
        self._stop.set()


async def serve(engine: Engine, host: str, port: int, speed: float = 1.0, origins=None, ready: asyncio.Event | None = None, server_box: list | None = None) -> None:
    import websockets

    srv = Server(engine, speed)
    if server_box is not None:
        server_box.append(srv)
    async with websockets.serve(srv.handler, host, port, origins=origins or DEFAULT_ORIGINS, max_size=MAX_MESSAGE_BYTES, max_queue=16):
        if ready is not None:
            ready.set()
        await srv.ticker()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dct_sensors.serve", description="DC-Twin 로컬 계산 서버(웹 보기 화면용)")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--solver", default="l0", choices=["l0", "l1", "l2"])
    ap.add_argument("--scenario", default="normal", choices=sorted(SCENARIOS))
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--speed", type=float, default=1.0, help="시간 배율(1이면 실시간)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--scene", default=None, help="(l1, l2) 홀 장면 USD 경로")
    ap.add_argument("--origin", action="append", default=[], help="허용할 웹 페이지 출처를 더한다(예: https://example.com)")
    ap.add_argument("--allow-remote", action="store_true", help="127.0.0.1이 아닌 주소로 여는 것을 허용한다(권장하지 않음)")
    args = ap.parse_args(argv)
    if not is_loopback(args.host) and not args.allow_remote:
        print(f"[서버] {args.host}는 이 컴퓨터 밖에서 접속할 수 있는 주소다. 조작을 받는 서버라 기본은 막아 둔다(--allow-remote로 허용).", file=sys.stderr)
        return 2
    if not SPEED_RANGE[0] <= args.speed <= SPEED_RANGE[1]:
        print(f"[서버] --speed는 {SPEED_RANGE[0]}~{SPEED_RANGE[1]} 사이여야 한다", file=sys.stderr)
        return 2
    cfg = Config.load(args.config)
    m = load_manifest(args.manifest)
    kw = {"scene": args.scene} if args.solver in ("l1", "l2") and args.scene else {}
    engine = Engine(m, cfg, args.solver, args.scenario, args.seed, kw)
    print(f"[서버] solver {args.solver}, 시나리오 {args.scenario}, ws://{args.host}:{args.port}/ws (웹: ?live=ws://{args.host}:{args.port}/ws)", file=sys.stderr)
    try:
        asyncio.run(serve(engine, args.host, args.port, args.speed, DEFAULT_ORIGINS + args.origin))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
