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
import hmac
import ipaddress
import json
import os
import re
import secrets
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .api import DataApi, origin_allowed
from .config import Config
from .generator import Generator, iso
from .manifest import Manifest, load_manifest
from .scenarios import SCENARIOS, get
from .solvers import make_solver

MAX_MESSAGE_BYTES = 1024          # 웹이 보내는 조작 한 건의 최대 크기
MAX_JOB_MESSAGE_BYTES = 16384     # 시뮬레이션 작업 요청 한 건의 최대 크기(랙 60기 전력까지 담을 수 있게)
MAX_CLIENTS = 8
CONTROLS_PER_SECOND = 20          # 접속 하나가 초당 보낼 수 있는 조작 수
SPEED_RANGE = (0.5, 20.0)
POWER_RANGE = (0.0, 3.0)
SUPPLY_RANGE = (14.0, 27.0)       # 급기 온도(도). 웹 간이 계산과 같은 범위
MIN_TOKEN_LEN = 16                # 접근 토큰의 최소 길이
AUTH_TIMEOUT_S = 5.0              # 접속한 뒤 이 시간 안에 첫 메시지로 토큰을 보내야 한다
MAX_PENDING = 16                  # 아직 인증하지 않은 접속의 최대 수
MAX_PENDING_PER_PEER = 4          # 같은 주소가 인증을 기다리며 잡아 둘 수 있는 자리(한 곳이 16자리를 다 차지하지 못하게)
SLOW_CLIENT_BUFFER = 4 * 1024 * 1024  # 보내지 못하고 쌓인 바이트가 이보다 많으면 느린 접속으로 보고 끊는다(docs/30 L5)
FAILS_MAX = 1024                  # 틀린 토큰 기록을 둘 주소 수 상한(넘으면 1분 지난 것, 그래도 넘으면 오래된 것부터 버린다)
AUTH_FAILS_PER_MINUTE = 5         # 같은 주소에서 틀린 토큰을 보낼 수 있는 횟수(분당). 넘으면 잠시 막는다


def repo_root_of(module_file: Path) -> Path | None:
    """이 모듈이 저장소 안에 있으면 저장소 루트, 컨테이너처럼 저장소 밖에 복사되어 있으면 None."""
    parents = Path(module_file).resolve().parents
    return parents[3] if len(parents) > 3 and (parents[3] / "sim" / "sensors").exists() else None


REPO = repo_root_of(Path(__file__))
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
        self.supply0 = cfg.t_supply  # 시나리오를 다시 시작하면 이 값으로 돌아간다
        self.start(scenario)

    def _controls(self) -> dict:
        g = self.gen
        return {"fan": dict(g.fan_ctl), "powerScale": dict(g.power_scale), "supply": self.cfg.t_supply} if g else {}

    def start(self, scenario: str) -> dict:
        """시나리오를 처음부터 시작한다. l0는 모델 상태도 새로 만들고, l1/l2는 열 상태를 이어 간다(제어만 처음으로)."""
        with self.lock:
            self.cfg.t_supply = self.supply0
            if hasattr(self.solver, "set_supply"):
                self.solver.set_supply(self.supply0)
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
    if isinstance(d, dict) and d.get("type") == "auth":
        return {"kind": "auth"}  # 인증이 꺼진 서버에 토큰을 보낸 화면: 무시한다(오류로 보이지 않게)
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
    if kind == "supply_temp":
        value = d.get("value")
        if not _num(value) or not SUPPLY_RANGE[0] <= value <= SUPPLY_RANGE[1]:
            raise ValueError(f"급기 온도는 {SUPPLY_RANGE[0]:g}~{SUPPLY_RANGE[1]:g}도여야 한다")
        return {"kind": kind, "target": "hall", "value": float(value)}
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


def check_token(token: str) -> str:
    """접근 토큰이 쓸 만한지 본다. 너무 짧으면 ValueError."""
    if not isinstance(token, str) or len(token) < MIN_TOKEN_LEN or token.strip() != token or any(c.isspace() for c in token):
        raise ValueError(f"접근 토큰은 공백 없이 {MIN_TOKEN_LEN}자 이상이어야 한다(`--token auto`로 만들 수 있다)")
    return token


def parse_auth(raw) -> str | None:
    """첫 메시지가 {"type":"auth","token":문자열}이면 토큰, 아니면 None."""
    if not isinstance(raw, (str, bytes)) or len(raw) > MAX_MESSAGE_BYTES:
        return None
    try:
        d = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if isinstance(d, dict) and d.get("type") == "auth" and isinstance(d.get("token"), str) and len(d["token"]) <= 256:
        return d["token"]
    return None


def parse_job_message(raw: str | bytes) -> dict | None:
    """시뮬레이션 작업 메시지면 {action, id?, conditions?}, 아니면 None. 틀린 작업 메시지는 ValueError.

    받는 것: {"type":"job","action":"submit","conditions":{...}} / {"type":"job","action":"status|cancel|result","id":"..."} / {"type":"job","action":"list"}"""
    if len(raw) > MAX_JOB_MESSAGE_BYTES:
        raise ValueError("메시지가 너무 크다")
    if (b'"job"' if isinstance(raw, bytes) else '"job"') not in raw:
        return None
    try:
        d = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(d, dict) or d.get("type") != "job":
        return None
    action = d.get("action")
    if action not in ("submit", "status", "cancel", "result", "list"):
        raise ValueError("알 수 없는 작업 동작")
    out = {"action": action}
    if action == "submit":
        if not isinstance(d.get("conditions"), dict):
            raise ValueError("조건(conditions)은 객체여야 한다")
        out["conditions"] = d["conditions"]
    elif action != "list":
        jid = d.get("id")
        if not isinstance(jid, str) or not re.fullmatch(r"[0-9a-f]{6,32}", jid):
            raise ValueError("작업 id가 올바르지 않다")
        out["id"] = jid
    return out


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def solver_meta(sol) -> tuple[str, dict | None]:
    """격벽 방식("hot"/"cold")과 보정 모델 출처 요약(docs/34 6장). 화면이 서버 값이 HAC인지 CAC인지 표시한다.
    L2는 cac 속성, L1은 lay.cac로 장면을 판단한다. L0은 장면을 읽지 않으므로 HAC."""
    containment = "cold" if getattr(sol, "cac", False) or getattr(getattr(sol, "lay", None), "cac", False) else "hot"
    prov = getattr(sol, "provenance", None)
    model = {k: prov.get(k) for k in ("source", "containment", "trained_at", "n_samples", "stale")} if isinstance(prov, dict) else None
    return containment, model


class Server:
    def __init__(self, engine: Engine, speed: float = 1.0, api: DataApi | None = None, token: str | None = None, clock=time.monotonic, jobs=None):
        self.engine = engine
        self.jobs = jobs  # 시뮬레이션 작업 관리자(jobs.JobManager). 없으면 작업 메시지를 거절한다
        self.origins = DEFAULT_ORIGINS  # 허용하는 웹 페이지 출처(serve()가 정한다). 확인은 process_request에서
        self.api = api
        self.token = token
        self.clock = clock
        self.pending = 0  # 인증을 기다리는 접속 수
        self.pending_by: dict[str, int] = {}  # 주소별 인증 대기 수
        self.fails: dict[str, tuple[float, int]] = {}  # 주소 -> (창 시작, 틀린 횟수)
        self.speed = speed
        self.clients: set = set()
        self._stop = asyncio.Event()

    async def ticker(self) -> None:
        loop = asyncio.get_running_loop()
        nxt = loop.time()
        while not self._stop.is_set():
            try:
                msgs = await loop.run_in_executor(None, self.engine.step)
            except Exception as exc:  # noqa: BLE001  한 단계의 계산 오류로 서버 전체가 죽지 않게 한다
                print(f"[서버] 계산 중 오류, 1초 뒤 계속한다: {type(exc).__name__}: {exc}", file=sys.stderr)
                await asyncio.sleep(1.0)
                nxt = loop.time()
                continue
            for m in msgs:
                self.broadcast(json.dumps(m, ensure_ascii=False, separators=(",", ":")))
            nxt += self.engine.cfg.interval_s / self.speed
            delay = nxt - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                nxt = loop.time()  # 계산이 느리면 따라잡으려 몰아서 보내지 않고 그 시점부터 다시 맞춘다

    async def process_request(self, connection, request):
        """같은 포트에서 HTTP 데이터 API(GET /api/...)를 먼저 받고, 그 밖의 요청은 WebSocket 핸드셰이크로 넘긴다.

        websockets 13 이상(새 API: (connection, request))과 12 이하(옛 API: (path, request_headers))를 모두 받는다.
        Omniverse Kit 안에서는 Kit에 들어 있는 websockets 12.0이 쓰인다(server/kit_server.py, 2026-11-10 확인)."""
        legacy = not hasattr(request, "headers")
        path, headers = (connection, request) if legacy else (request.path, request.headers)

        def respond(status: int, reason: str, hdrs: dict, body: bytes):
            if legacy:
                return status, list(hdrs.items()), body
            from websockets.datastructures import Headers
            from websockets.http11 import Response

            return Response(status, reason, Headers(hdrs), body)

        if headers.get("Upgrade", "").lower() == "websocket":
            # 웹 페이지 출처 확인을 여기서 한다. websockets 12의 origins는 정규식을 받지 않아 localhost의 아무 포트나 허용하는 규칙을 못 쓴다
            # (Kit 안에서 브라우저 접속이 모두 403이었다, 2026-11-10).
            if not origin_allowed(headers.get("Origin"), self.origins):
                return respond(403, "Forbidden", {"Content-Type": "text/plain; charset=utf-8"}, "허용하지 않은 웹 페이지 출처".encode("utf-8"))
            return None
        if self.api is None:
            return None
        reply = self.api.route("GET", path, headers)  # 이 서버의 HTTP는 읽기 전용이라 GET만 들어온다
        if reply is None:
            return None
        return respond(reply.status, reply.reason, reply.headers, reply.body)

    def broadcast(self, text: str) -> None:
        """모든 접속에 보낸다. websockets.broadcast는 기다리지 않고 쓰기 버퍼에 쌓기만 해서(되밀림 없음) 받지 못하는 접속이 있으면
        서버 메모리가 계속 는다. 쌓인 양이 SLOW_CLIENT_BUFFER를 넘은 접속은 1013(잠시 뒤 다시)으로 닫고 보내지 않는다(docs/30 L5)."""
        import websockets

        if not self.clients:
            return
        ok = []
        for ws in list(self.clients):
            tr = getattr(ws, "transport", None)
            size = tr.get_write_buffer_size() if tr is not None else 0
            if size > SLOW_CLIENT_BUFFER:
                print(f"[서버] 느린 접속을 끊는다({self._peer(ws)}, 쌓인 {size} 바이트)", file=sys.stderr)
                self.clients.discard(ws)
                if tr is not None:
                    tr.abort()  # 닫기 인사도 그 버퍼 뒤에 쌓이므로 바로 끊는다
                continue
            ok.append(ws)
        if ok:
            websockets.broadcast(ok, text)

    def _peer(self, ws) -> str:
        addr = getattr(ws, "remote_address", None)
        return str(addr[0]) if addr else "?"

    def _blocked(self, peer: str) -> bool:
        start, n = self.fails.get(peer, (0.0, 0))
        return n >= AUTH_FAILS_PER_MINUTE and self.clock() - start < 60.0

    def _record_fail(self, peer: str) -> None:
        now = self.clock()
        start, n = self.fails.get(peer, (now, 0))
        self.fails[peer] = (now, 1) if now - start >= 60.0 else (start, n + 1)
        if len(self.fails) > FAILS_MAX:  # 오래된 기록을 버린다
            self.fails = {k: v for k, v in self.fails.items() if now - v[0] < 60.0}
            if len(self.fails) > FAILS_MAX:  # 1분 안의 주소가 그래도 많으면(주소를 바꿔 가며 보내는 경우) 상한까지만 남긴다
                keep = sorted(self.fails.items(), key=lambda kv: kv[1][0])[-FAILS_MAX:]
                self.fails = dict(keep)

    async def authenticate(self, ws) -> bool:
        """토큰이 켜져 있으면 첫 메시지로 토큰을 받는다. 이 단계 전에는 어떤 값도 보내지 않는다. 실패하면 연결을 닫고 False."""
        import websockets

        peer = self._peer(ws)
        if self._blocked(peer):
            await ws.close(1013, "틀린 시도가 많아 잠시 막았다")
            return False
        if self.pending >= MAX_PENDING or self.pending_by.get(peer, 0) >= MAX_PENDING_PER_PEER:
            await ws.close(1013, "접속이 너무 많다")
            return False
        self.pending += 1
        self.pending_by[peer] = self.pending_by.get(peer, 0) + 1
        try:
            try:
                raw = await asyncio.wait_for(ws.recv(), AUTH_TIMEOUT_S)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                self._record_fail(peer)  # 아무 말 없이 자리만 차지하는 접속도 틀린 시도로 센다(반복하면 잠시 막힌다)
                await ws.close(1008, "인증 시간이 지났다")
                return False
            got = parse_auth(raw)
            if got is None or not hmac.compare_digest(got.encode("utf-8"), self.token.encode("utf-8")):
                self._record_fail(peer)
                print(f"[서버] 인증 실패: {peer}", file=sys.stderr)
                await ws.close(1008, "인증 실패")
                return False
            await ws.send(json.dumps({"type": "auth", "ok": True}))
            return True
        finally:
            self.pending -= 1
            left = self.pending_by.get(peer, 1) - 1
            if left > 0:
                self.pending_by[peer] = left
            else:
                self.pending_by.pop(peer, None)

    async def handler(self, ws) -> None:
        import websockets

        if self.token and not await self.authenticate(ws):
            return
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
                    j = parse_job_message(raw if isinstance(raw, (bytes, str)) else "")
                    if j is not None:
                        await self._job(ws, j)
                        continue
                    c = validate_control(raw if isinstance(raw, (bytes, str)) else "", self.engine.m)
                    if c["kind"] == "auth":
                        continue
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

    async def _job(self, ws, j: dict) -> None:
        """시뮬레이션 작업 요청을 처리한다. 진행 상황은 관리자의 알림으로 모든 접속에 따로 보낸다."""
        if self.jobs is None:
            raise ValueError("이 서버는 시뮬레이션 작업을 받지 않는다(--jobs로 켠다)")
        loop = asyncio.get_running_loop()
        a = j["action"]
        try:
            if a == "submit":
                st = await loop.run_in_executor(None, self.jobs.submit, j["conditions"])
            elif a == "status":
                st = self.jobs.status(j["id"])
            elif a == "cancel":
                st = self.jobs.cancel(j["id"])
            elif a == "list":
                with self.jobs.lock:
                    items = [x.public(self.jobs._position(x)) for x in sorted(self.jobs.jobs.values(), key=lambda x: x.created)][-20:]
                await ws.send(json.dumps({"type": "job_list", "jobs": items}, ensure_ascii=False))
                return
            else:  # result
                p = self.jobs.result_path(j["id"])
                rec = await loop.run_in_executor(None, lambda: json.loads(p.read_text(encoding="utf-8")))
                await ws.send(json.dumps({"type": "job_result", "id": j["id"], "rec": rec}, ensure_ascii=False, separators=(",", ":")))
                return
        except KeyError:
            raise ValueError("그런 작업이 없다") from None
        except FileNotFoundError:
            raise ValueError("아직 결과가 없다") from None
        await ws.send(json.dumps({"type": "job", "job": st}, ensure_ascii=False))

    def job_event(self, snap: dict) -> None:
        """작업 관리자(다른 스레드)가 부르는 알림. 서버의 이벤트 루프에서 모든 접속에 보낸다."""
        loop = getattr(self, "_loop", None)
        if loop is None:
            return

        def send():
            self.broadcast(json.dumps({"type": "job", "job": snap}, ensure_ascii=False))

        loop.call_soon_threadsafe(send)

    def stop(self) -> None:
        self._stop.set()


async def serve(engine: Engine, host: str, port: int, speed: float = 1.0, origins=None, ready: asyncio.Event | None = None, server_box: list | None = None, api: DataApi | None = None, token: str | None = None,
                jobs=None) -> None:
    import websockets

    srv = Server(engine, speed, api, token, jobs=jobs)
    srv.origins = origins or DEFAULT_ORIGINS
    srv._loop = asyncio.get_running_loop()
    if jobs is not None:
        jobs.listeners.append(srv.job_event)
    if server_box is not None:
        server_box.append(srv)
    max_size = MAX_JOB_MESSAGE_BYTES if jobs is not None else MAX_MESSAGE_BYTES
    async with websockets.serve(srv.handler, host, port, max_size=max_size, max_queue=16, process_request=srv.process_request):  # 출처 확인은 srv.process_request
        if ready is not None:
            ready.set()
        import signal

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):  # docker stop(SIGTERM)에 바로 정리하고 끝난다. Windows는 지원하지 않아 건너뛴다
            try:
                loop.add_signal_handler(sig, srv.stop)
            except (NotImplementedError, RuntimeError, ValueError):
                break
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
    ap.add_argument("--data-dir", default=None, help="미리 계산한 값(index.json, library.json, rec/)이 있는 폴더. 기본은 저장소의 web/viewer/public/data 또는 환경 변수 DCT_DATA_DIR")
    ap.add_argument("--extra-data-dir", action="append", default=[], help="추가로 줄 자료 폴더(예: 외부 솔버 결과 묶음 sim/out/local_only/external_pack). 이 컴퓨터의 서버가 줄 때만 화면에 보인다")
    ap.add_argument("--origin", action="append", default=[], help="허용할 웹 페이지 출처를 더한다(예: https://example.com)")
    ap.add_argument("--allow-remote", action="store_true", help="127.0.0.1이 아닌 주소로 여는 것을 허용한다(접근 토큰이 필요하다)")
    ap.add_argument("--token", default=None, help="접근 토큰(16자 이상). `auto`면 만들어서 한 번 보여 준다. 환경 변수 DCT_TOKEN도 된다. 켜면 WebSocket은 첫 메시지로 토큰을 보내야 하고 데이터 API는 Authorization: Bearer가 필요하다")
    ap.add_argument("--private-data", action="store_true", help="토큰이 있을 때 데이터 API(/api/...)도 Authorization: Bearer를 요구한다. 기본은 공개(값이 공개 사이트에 이미 있다). 브라우저는 사전 확인을 못 해 이 모드에서 데이터를 받지 못하고 사이트의 파일을 쓴다")
    ap.add_argument("--jobs", action="store_true", help="시뮬레이션 작업(조건을 받아 OpenFOAM 흐름 + 우리 온도 계산)을 받는다. Warp, pxr, WSL의 OpenFOAM이 필요하다(docs/31, docs/32)")
    ap.add_argument("--jobs-dir", default=None, help="작업 결과 폴더(기본 sim/out/jobs)")
    ap.add_argument("--no-auth", action="store_true", help="127.0.0.1 밖으로 열면서 토큰을 쓰지 않는다(권장하지 않음, 누구나 조작할 수 있다)")
    args = ap.parse_args(argv)
    if not is_loopback(args.host) and not args.allow_remote:
        print(f"[서버] {args.host}는 이 컴퓨터 밖에서 접속할 수 있는 주소다. 조작을 받는 서버라 기본은 막아 둔다(--allow-remote로 허용).", file=sys.stderr)
        return 2
    token = args.token or os.environ.get("DCT_TOKEN") or None
    if token == "auto":
        token = secrets.token_urlsafe(24)
        print(f"[서버] 접근 토큰(이 줄은 한 번만 보인다): {token}", file=sys.stderr)
    if token:
        try:
            check_token(token)
        except ValueError as e:
            print(f"[서버] {e}", file=sys.stderr)
            return 2
    elif not is_loopback(args.host) and not args.no_auth:
        print("[서버] 이 컴퓨터 밖에서 닿는 주소로 열려면 접근 토큰이 필요하다(--token auto 또는 환경 변수 DCT_TOKEN). 토큰 없이 열려면 --no-auth를 명시한다.", file=sys.stderr)
        return 2
    if not SPEED_RANGE[0] <= args.speed <= SPEED_RANGE[1]:
        print(f"[서버] --speed는 {SPEED_RANGE[0]}~{SPEED_RANGE[1]} 사이여야 한다", file=sys.stderr)
        return 2
    cfg = Config.load(args.config)
    m = load_manifest(args.manifest)
    kw = {"scene": args.scene} if args.solver in ("l1", "l2") and args.scene else {}
    engine = Engine(m, cfg, args.solver, args.scenario, args.seed, kw)
    origins = DEFAULT_ORIGINS + args.origin
    data_dir = args.data_dir or os.environ.get("DCT_DATA_DIR") or (REPO / "web" / "viewer" / "public" / "data" if REPO else None)
    mgr = None
    if args.jobs:
        from . import jobs as jobs_mod
        from . import precise

        out = Path(args.jobs_dir) if args.jobs_dir else (REPO / "sim" / "out" / "jobs" if REPO else Path("jobs"))
        mgr = jobs_mod.JobManager(m, out, precise.make_stages(m), stage_scale={"steady": precise.steady_runs_needed(m, out / "flows")})
    jobs_meta = {"enabled": mgr is not None, "durationRange": [60, 1800], "supplyRange": list(SUPPLY_RANGE), "powerRange": list(POWER_RANGE), "maxQueue": 3,
                 "model": "openfoam_flow+fv" if mgr else None}
    containment, model_meta = solver_meta(engine.solver)
    api = DataApi(data_dir if data_dir and Path(data_dir).exists() else None, origins, extra_dirs=args.extra_data_dir, token=token, public_data=not args.private_data, meta={"name": "dct-sim-server", "version": 1, "solver": args.solver, "containment": containment, "model": model_meta, "scenarios": sorted(SCENARIOS), "controls": ["scenario", "crac_fan", "rack_power_scale", "supply_temp", "speed"], "supplyRange": list(SUPPLY_RANGE), "jobs": jobs_meta})
    print(f"[서버] 인증: {'켬(토큰 ' + str(len(token)) + '자, 데이터 읽기는 ' + ('비공개' if args.private_data else '공개') + ')' if token else '끔(이 컴퓨터에서만 열려 있음)' if is_loopback(args.host) else '끔(--no-auth, 누구나 조작 가능)'}", file=sys.stderr)
    print(f"[서버] solver {args.solver}, 격벽 {'CAC' if containment == 'cold' else 'HAC'}, 시나리오 {args.scenario}, ws://{args.host}:{args.port}/ws, 데이터 API http://{args.host}:{args.port}/api/meta (라이브러리 {api.meta['libraryEntries']}개)", file=sys.stderr)
    try:
        asyncio.run(serve(engine, args.host, args.port, args.speed, origins, api=api, token=token, jobs=mgr))
    except KeyboardInterrupt:
        pass
    finally:
        if mgr is not None:
            mgr.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
