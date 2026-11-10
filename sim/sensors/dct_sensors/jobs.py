"""시뮬레이션 작업 (docs/31 3~4장). 사용자가 정한 조건으로 서버에서 계산하고 진행률과 남은 시간을 알려 준다.

흐름: 조건(JSON) 검사 → 조건을 USD 층으로 쓴다(`job.usda`, 장면 위에 얹는 override) → 계산은 그 층을 다시 읽어 조건을 얻는다
→ 단계별로 계산(시간 변화, 정상 상태) → 웹 녹화 형식(`result.json`)으로 저장한다.

- 조건의 정본은 USD 층이다. 같은 층을 Unreal이나 Kit에서 열면 어떤 조건으로 계산했는지 볼 수 있고, 결과마다 남아 재현된다.
- 이 파일은 Kit이 없어도 돈다(시험, CI). Kit 안에서도 같은 코드를 쓴다(`server/kit_server.py`).
- GPU 작업은 한 번에 하나, 대기열은 최대 MAX_QUEUE개. 같은 조건의 결과가 있으면 다시 계산하지 않는다.
- 결과는 시각화 목적이다. 공학적 정확성을 주장하지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .manifest import Manifest
from .scenarios import Event, Scenario

# 조건의 범위. 서버 조작(serve.py)과 같은 범위를 쓴다(시험이 같은지 확인한다).
SUPPLY_RANGE = (14.0, 27.0)
POWER_RANGE = (0.0, 3.0)
DURATION_RANGE = (60, 1800)
MAX_QUEUE = 3
MAX_KEEP = 40  # 결과 폴더를 이 개수까지 남긴다(오래된 것부터 지움)

STAGE_TITLES = {"usd": "조건을 USD 층으로", "steady": "공기 흐름(OpenFOAM)", "transient": "시간 변화와 센서 값(Warp 온도 계산)", "result": "결과 정리"}


# ---------------------------------------------------------------- 조건
def validate_conditions(raw, manifest: Manifest) -> dict:
    """조건을 검사하고 정해진 모양으로 바꾼다. 틀리면 ValueError(이유는 한국어)."""
    if not isinstance(raw, dict):
        raise ValueError("조건은 객체여야 한다")
    unknown = set(raw) - {"duration", "supply", "fans", "power", "failures", "precise"}
    if unknown:
        raise ValueError(f"알 수 없는 조건: {', '.join(sorted(unknown))}")

    def num(v, lo, hi, what):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f"{what}은(는) {lo:g}~{hi:g}이어야 한다")
        return float(v)

    duration = int(num(raw.get("duration", 300), *DURATION_RANGE, "길이(초)"))
    supply = round(num(raw.get("supply", 18.0), *SUPPLY_RANGE, "급기 온도"), 2)
    fans_in = raw.get("fans", {}) or {}
    if not isinstance(fans_in, dict):
        raise ValueError("fans는 객체여야 한다")
    fans = {}
    for c in manifest.cracs:
        fans[c] = round(num(fans_in.get(c, 1.0), 0.0, 1.0, f"{c} 팬 속도"), 3)
    for k in fans_in:
        if k not in fans:
            raise ValueError(f"알 수 없는 CRAC: {k}")
    power_in = raw.get("power", {}) or {}
    if not isinstance(power_in, dict):
        raise ValueError("power는 객체여야 한다")
    power = {}
    for k, v in power_in.items():
        row_ok = isinstance(k, str) and re.fullmatch(r"row:\d{2}", k) and 1 <= int(k[4:]) <= manifest.n_rows
        if not (row_ok or k in manifest.racks):
            raise ValueError(f"알 수 없는 랙이나 줄: {k}")
        val = round(num(v, *POWER_RANGE, f"{k} 전력 배수"), 3)
        if val != 1.0:
            power[k] = val
    fails_in = raw.get("failures", []) or []
    if not isinstance(fails_in, list) or len(fails_in) > len(manifest.cracs):
        raise ValueError("failures는 CRAC 수 이하의 목록이어야 한다")
    failures = []
    for f in fails_in:
        if not isinstance(f, dict) or f.get("crac") not in manifest.cracs:
            raise ValueError("고장 대상은 CRAC 이름이어야 한다")
        failures.append({"crac": f["crac"], "t": int(num(f.get("t", 0), 0, duration - 1, "고장 시각(초)"))})
    if len({f["crac"] for f in failures}) != len(failures):
        raise ValueError("같은 CRAC의 고장을 두 번 넣었다")
    failures.sort(key=lambda f: (f["t"], f["crac"]))
    precise = raw.get("precise", True)
    if not isinstance(precise, bool):
        raise ValueError("precise는 참/거짓이어야 한다")
    return {"duration": duration, "supply": supply, "fans": fans, "power": dict(sorted(power.items())), "failures": failures, "precise": precise}


def condition_key(cond: dict) -> str:
    """같은 조건이면 같은 키(결과를 다시 쓰는 데 쓴다)."""
    return hashlib.sha256(json.dumps(cond, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def scenario_from_conditions(cond: dict) -> Scenario:
    """조건을 센서 생성기의 시나리오(제어 이벤트 목록)로 바꾼다. 0초에 팬과 전력을 맞추고, 고장 시각에 팬을 0으로."""
    ev = [Event(0, "crac_fan", c, v) for c, v in cond["fans"].items() if v != 1.0]
    rows = sorted(k for k in cond["power"] if k.startswith("row:"))
    racks = sorted(k for k in cond["power"] if not k.startswith("row:"))
    ev += [Event(0, "rack_power_scale", k, cond["power"][k]) for k in rows + racks]  # 줄 먼저, 랙이 덮어쓴다
    ev += [Event(f["t"], "crac_fan", f["crac"], 0.0) for f in cond["failures"]]
    return Scenario("custom", "사용자가 정한 조건(docs/31)", tuple(ev))


# ---------------------------------------------------------------- USD 층
def equipment_paths(manifest: Manifest) -> dict[str, str]:
    """장비 이름(crac_01, rack_05) -> USD prim 경로. 매니페스트의 장비 경로에서 얻는다."""
    out: dict[str, str] = {}
    for s in manifest.sensors:
        out.setdefault(s.equipment, s.equipment_path)
    return out


def _over_tree(paths_attrs: dict[str, list[str]]) -> str:
    """{prim 경로: [속성 줄]} -> 중첩된 over 블록 텍스트."""
    tree: dict = {}
    for p, attrs in paths_attrs.items():
        node = tree
        for part in p.strip("/").split("/"):
            node = node.setdefault(part, {})
        node.setdefault("__attrs__", []).extend(attrs)

    def emit(node, depth):
        pad = "    " * depth
        lines = [f"{pad}{a}" for a in node.get("__attrs__", [])]
        for name, child in node.items():
            if name == "__attrs__":
                continue
            lines.append(f'{pad}over "{name}"')
            lines.append(f"{pad}{{")
            lines.extend(emit(child, depth + 1))
            lines.append(f"{pad}}}")
        return lines

    return "\n".join(emit(tree, 0))


def conditions_to_usda(cond: dict, manifest: Manifest, scene_path: str) -> str:
    """조건을 장면 위에 얹는 USD 층(텍스트)으로 만든다. 속성 접두는 dct:."""
    eq = equipment_paths(manifest)
    hall = "/" + "/".join(next(iter(eq.values())).strip("/").split("/")[:2])  # /DC/Hall01
    attrs: dict[str, list[str]] = {hall: [
        f"custom double dct:job:supplyTempC = {cond['supply']}",
        f"custom int dct:job:durationS = {cond['duration']}",
        f"custom bool dct:job:precise = {1 if cond['precise'] else 0}",
    ]}
    fail_at = {f["crac"]: f["t"] for f in cond["failures"]}
    for c, v in cond["fans"].items():
        a = [f"custom double dct:job:fanRatio = {v}"]
        if c in fail_at:
            a.append(f"custom double dct:job:failAtS = {fail_at[c]}")
        attrs[eq[c]] = a
    for k, v in cond["power"].items():
        if k.startswith("row:"):
            any_rack = next(n for n, (r, _) in manifest.racks.items() if r == int(k[4:]))
            path = eq[any_rack].rsplit("/", 1)[0]  # 줄 prim
        else:
            path = eq[k]
        attrs.setdefault(path, []).append(f"custom double dct:job:powerScale = {v}")
    key = condition_key(cond)
    head = f'#usda 1.0\n(\n    doc = "DC-Twin 시뮬레이션 조건 층 (docs/31). 장면 위에 얹어 연다. 시각화 목적."\n    customLayerData = {{\n        string "dct:job:key" = "{key}"\n    }}\n    subLayers = [\n        @{scene_path}@\n    ]\n)\n\n'
    return head + _over_tree(attrs) + "\n"


def conditions_from_usd(layer_path: str | Path, manifest: Manifest) -> dict:
    """USD 층에서 조건을 다시 읽는다(계산은 이 값을 쓴다). pxr(usd-core 또는 Kit)이 필요하다.
    장면(subLayer)은 열지 않고 층 하나만 읽는다(빠르고, 장면이 없어도 된다)."""
    from pxr import Sdf

    layer = Sdf.Layer.FindOrOpen(str(layer_path))
    if layer is None:
        raise ValueError(f"USD 층을 열 수 없다: {layer_path}")
    eq = equipment_paths(manifest)
    hall = "/" + "/".join(next(iter(eq.values())).strip("/").split("/")[:2])

    def get(path, name, default=None):
        spec = layer.GetAttributeAtPath(Sdf.Path(path).AppendProperty(name))
        return default if spec is None else spec.default

    raw = {"duration": int(get(hall, "dct:job:durationS")), "supply": float(get(hall, "dct:job:supplyTempC")),
           "precise": bool(get(hall, "dct:job:precise")), "fans": {}, "power": {}, "failures": []}
    for c in manifest.cracs:
        raw["fans"][c] = float(get(eq[c], "dct:job:fanRatio", 1.0))
        t = get(eq[c], "dct:job:failAtS")
        if t is not None:
            raw["failures"].append({"crac": c, "t": int(t)})
    for r in range(1, manifest.n_rows + 1):
        any_rack = next(n for n, (row, _) in manifest.racks.items() if row == r)
        v = get(eq[any_rack].rsplit("/", 1)[0], "dct:job:powerScale")
        if v is not None:
            raw["power"][f"row:{r:02d}"] = float(v)
    for n in manifest.racks:
        v = get(eq[n], "dct:job:powerScale")
        if v is not None:
            raw["power"][n] = float(v)
    return validate_conditions(raw, manifest)


# ---------------------------------------------------------------- 웹 녹화 형식
CONF_CODE = {"ok": 1, "caution": 2, "low": 3, "fallback": 4}
AGGREGATES = ("it_power", "cooling_power", "facility_power", "pue", "energy_kwh")


def _r3(v):
    return round(v, 3) if isinstance(v, (int, float)) and math.isfinite(v) else None


def datetime_ms(ts: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000


def to_web_recording(msgs: list[dict], scenario_id: str, sensor_ids: list[str]) -> dict:
    """센서 생성기 메시지를 웹 녹화(`web/viewer/src/recording.js` parseRecording)로 바꾼다.
    `web/viewer/tools/build_data.mjs` convertRecording과 같은 규칙이다(시험이 같은지 확인)."""
    from datetime import datetime

    def ms(ts):
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000

    if not msgs:
        raise ValueError("메시지가 없다")
    start = min(ms(m["ts"]) for m in msgs)

    def sec(ts):
        d = (ms(ts) - start) / 1000
        if abs(d - round(d)) > 1e-6:
            raise ValueError(f"시각이 1초 간격이 아니다 ({ts})")
        return int(round(d))

    samples = [m for m in msgs if m["type"] == "sample"]
    n = max(sec(m["ts"]) for m in samples) + 1
    known = set(sensor_ids)
    values = {i: [None] * n for i in sensor_ids}
    est: dict = {}
    for m in samples:
        if m["sensorId"] not in known:
            continue
        t = sec(m["ts"])
        values[m["sensorId"]][t] = _r3(m["value"]) if m.get("quality", "good") == "good" else None
        if "confidence" in m or "lower" in m:
            e = est.setdefault(m["sensorId"], {"lower": [None] * n, "upper": [None] * n, "conf": [0] * n})
            e["lower"][t], e["upper"][t] = _r3(m.get("lower")), _r3(m.get("upper"))
            e["conf"][t] = CONF_CODE.get(m.get("confidence"), 0)
    aggregates = {a: [None] * n for a in AGGREGATES}
    for m in msgs:
        if m["type"] == "aggregate" and m["name"] in aggregates:
            aggregates[m["name"]][sec(m["ts"])] = _r3(m["value"])
    model = next((m.get("model") for m in msgs if m["type"] == "scenario" and m.get("event") == "start" and m.get("model")), None)
    start_iso = datetime.fromtimestamp(start / 1000, tz=__import__("datetime").timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    out = {"version": 1, "scenario": scenario_id, "startTs": start_iso, "dt": 1, "n": n, "values": values, "est": est, "aggregates": aggregates}
    if model:
        out["meta"] = {"solver": "l2", "model": model}
    out["alarms"] = sorted(({"t": sec(m["ts"]), "sensorId": m["sensorId"], "from": m["from"], "to": m["to"], "value": _r3(m["value"])}
                            for m in msgs if m["type"] == "alarm"), key=lambda a: a["t"])
    out["events"] = [{"t": m.get("t", sec(m["ts"])), "kind": m["kind"], "target": m["target"], "value": m["value"]}
                     for m in msgs if m["type"] == "scenario" and m.get("event") == "event"]
    return out


# ---------------------------------------------------------------- 작업과 대기열
class Cancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    key: str
    cond: dict
    state: str = "queued"          # queued | running | done | failed | cancelled
    stage: str | None = None
    stages: list[str] = field(default_factory=list)
    progress: float = 0.0          # 전체 0~1
    stage_progress: float = 0.0
    eta_s: float | None = None     # 남은 시간(초, 추정). 모르면 None
    error: str | None = None
    notes: list[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    preview: bool = False          # 시간 변화 결과를 먼저 볼 수 있는가
    cached: bool = False
    plan: dict = field(default_factory=dict)  # 작업을 시작할 때 고정한 단계별 예상 시간(진행률이 뒤로 가지 않게)
    cancel_flag: threading.Event = field(default_factory=threading.Event)

    def public(self, position: int | None = None) -> dict:
        d = {"id": self.id, "key": self.key, "state": self.state, "stage": self.stage, "stageTitle": STAGE_TITLES.get(self.stage or ""),
             "stages": [{"id": s, "title": STAGE_TITLES[s]} for s in self.stages], "progress": round(self.progress, 4),
             "stageProgress": round(self.stage_progress, 4), "etaS": None if self.eta_s is None else round(self.eta_s, 1),
             "error": self.error, "notes": self.notes, "preview": self.preview, "cached": self.cached, "conditions": self.cond}
        if position is not None:
            d["position"] = position
        return d


# 단계별 예상 시간(초). 측정값에서 출발하고, 실제로 돈 시간으로 고쳐 간다(EstimateBook).
# 출처: docs/31 4.1(Kit 안 300초 계산 15.1초 + 센서 생성 20.4초, OpenFOAM 10 cm 451~672초 + 메시 약 8초)
DEFAULT_SECONDS = {"usd": 0.5, "transient": 40.0, "steady": 650.0, "result": 3.0}


class EstimateBook:
    """단계별 '모의 시간 1초당 걸린 실제 시간'을 기억해 다음 추정에 쓴다(길이에 비례하는 단계만)."""

    PER_SIM_SECOND = {"transient"}

    def __init__(self, path: Path | None = None):
        self.path = path
        self.rate: dict[str, float] = {}
        if path and path.exists():
            try:
                self.rate = {k: float(v) for k, v in json.loads(path.read_text(encoding="utf-8")).items()}
            except (ValueError, OSError):
                self.rate = {}

    def expect(self, stage: str, duration: int) -> float:
        if stage in self.rate:
            return self.rate[stage] * (duration if stage in self.PER_SIM_SECOND else 1)
        base = DEFAULT_SECONDS[stage]
        return base * (duration / 300 if stage in self.PER_SIM_SECOND else 1)

    def learn(self, stage: str, duration: int, seconds: float) -> None:
        r = seconds / (duration if stage in self.PER_SIM_SECOND else 1)
        self.rate[stage] = r if stage not in self.rate else 0.5 * self.rate[stage] + 0.5 * r
        if self.path:
            try:
                self.path.write_text(json.dumps(self.rate), encoding="utf-8")
            except OSError:
                pass


StageFn = Callable[["JobContext"], None]


class JobContext:
    """단계 함수에 건네는 것: 조건, 작업 폴더, 진행 보고, 취소 확인."""

    def __init__(self, manager: "JobManager", job: Job, folder: Path):
        self.manager, self.job, self.folder = manager, job, folder
        self.cond = job.cond
        self.data: dict = {}

    def progress(self, fraction: float) -> None:
        self.manager._progress(self.job, max(0.0, min(1.0, fraction)))

    def check(self) -> None:
        if self.job.cancel_flag.is_set():
            raise Cancelled()

    def note(self, text: str) -> None:
        self.job.notes.append(text)


class JobManager:
    """대기열과 작업 스레드. 단계 함수(stages)는 밖에서 넣는다(시험은 가짜 함수를, 서버는 실제 계산을)."""

    def __init__(self, manifest: Manifest, out_dir: Path, stages: dict[str, StageFn], *, max_queue: int = MAX_QUEUE,
                 max_keep: int = MAX_KEEP, estimates: EstimateBook | None = None, steady_available: bool = True, clock=time.monotonic,
                 stage_scale: dict | None = None):
        self.m, self.out = manifest, Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.stage_fns = stages
        self.max_queue, self.max_keep = max_queue, max_keep
        self.est = estimates or EstimateBook(self.out / "estimates.json")
        self.steady_available = steady_available
        # 단계별 일의 양 배수(조건 -> 수). 예: 정확한 계산에서 OpenFOAM을 돌려야 하는 팬 상태 수. 예상 시간과 학습에 함께 쓴다
        self.stage_scale = stage_scale or {}
        self.clock = clock
        self.jobs: dict[str, Job] = {}
        self.queue: list[str] = []
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.listeners: list[Callable[[dict], None]] = []
        self._stop = False
        self._stage_t0 = 0.0
        self.worker = threading.Thread(target=self._loop, name="dct-jobs", daemon=True)
        self.worker.start()

    # -- 밖에서 부르는 것
    def submit(self, raw) -> dict:
        cond = validate_conditions(raw, self.m)
        key = condition_key(cond)
        with self.lock:
            for j in self.jobs.values():  # 같은 조건이 대기 중이거나 도는 중이면 그 작업을 돌려준다
                if j.key == key and j.state in ("queued", "running"):
                    return j.public(self._position(j))
            job = Job(id=uuid.uuid4().hex[:12], key=key, cond=cond, stages=self._stages_for(cond))
            if (self.out / key / "result.json").exists():
                job.state, job.progress, job.cached, job.preview, job.finished = "done", 1.0, True, True, time.time()
                self.jobs[job.id] = job
                return job.public()
            if len(self.queue) >= self.max_queue:
                raise ValueError(f"대기열이 가득 찼다(최대 {self.max_queue}개). 잠시 뒤에 다시 보내라")
            self.jobs[job.id] = job
            self.queue.append(job.id)
            job.eta_s = self._eta(job)
            self.wake.notify()
            return job.public(self._position(job))

    def status(self, job_id: str) -> dict:
        with self.lock:
            j = self.jobs.get(job_id)
            if j is None:
                raise KeyError(job_id)
            return j.public(self._position(j))

    def cancel(self, job_id: str) -> dict:
        with self.lock:
            j = self.jobs.get(job_id)
            if j is None:
                raise KeyError(job_id)
            if j.state == "queued":
                self.queue.remove(j.id)
                j.state, j.finished = "cancelled", time.time()
            elif j.state == "running":
                j.cancel_flag.set()
            return j.public()

    def result_path(self, job_id: str, which: str = "result") -> Path:
        with self.lock:
            j = self.jobs.get(job_id)
        if j is None:
            raise KeyError(job_id)
        p = self.out / j.key / ("result.json" if which == "result" else "preview.json")
        if not p.exists():
            raise FileNotFoundError(str(p))
        return p

    def stop(self) -> None:
        with self.lock:
            self._stop = True
            for jid in self.queue:
                self.jobs[jid].state = "cancelled"
            self.queue.clear()
            for j in self.jobs.values():
                j.cancel_flag.set()
            self.wake.notify_all()

    # -- 안쪽
    def _stages_for(self, cond: dict) -> list[str]:
        # 정확한 계산: OpenFOAM이 공기 흐름을 먼저 풀고, 우리 온도 계산이 그 흐름으로 시간 변화를 낸다(docs/32 V4-3)
        if cond["precise"] and self.steady_available:
            return ["usd", "steady", "transient", "result"]
        return ["usd", "transient", "result"]

    def _position(self, j: Job) -> int | None:
        return self.queue.index(j.id) + 1 if j.id in self.queue else None

    def _scale(self, stage: str, cond: dict) -> float:
        fn = self.stage_scale.get(stage)
        try:
            return max(0.0, float(fn(cond))) if fn else 1.0
        except Exception:  # noqa: BLE001 - 배수 계산이 틀려도 작업은 돈다
            return 1.0

    def _expect(self, stage: str, cond: dict) -> float:
        return self.est.expect(stage, cond["duration"]) * self._scale(stage, cond)

    def _plan(self, j: Job) -> dict:
        return j.plan or {s: self._expect(s, j.cond) for s in j.stages}

    def _eta(self, j: Job) -> float:
        plan = self._plan(j)
        if j.state == "running" and j.stage:
            i = j.stages.index(j.stage)
            spent = self.clock() - self._stage_t0
            exp = plan[j.stage]
            if j.stage_progress > 0.05:  # 이 단계의 실제 속도로 남은 시간을 고친다
                exp = spent / j.stage_progress
            rest = max(exp - spent, 0.0)
            return rest + sum(plan[s] for s in j.stages[i + 1:])
        ahead = 0.0
        for jid in self.queue[: self._position(j) - 1 if self._position(j) else 0]:
            o = self.jobs[jid]
            ahead += sum(self._plan(o).values())
        running = next((o for o in self.jobs.values() if o.state == "running"), None)
        if running and running.eta_s:
            ahead += running.eta_s
        return ahead + sum(self._plan(j).values())

    def _progress(self, j: Job, frac: float) -> None:
        with self.lock:
            j.stage_progress = frac
            plan = self._plan(j)
            tot = sum(plan.values()) or 1.0
            i = j.stages.index(j.stage)
            done = sum(plan[s] for s in j.stages[:i]) + frac * plan[j.stage]
            j.progress = max(j.progress, min(done / tot, 0.999))
            j.eta_s = self._eta(j)
            snap = j.public()
        self._emit(snap)

    def _emit(self, snap: dict) -> None:
        for fn in list(self.listeners):
            try:
                fn(snap)
            except Exception:  # noqa: BLE001 - 듣는 쪽 오류가 작업을 멈추지 않게
                pass

    def _loop(self) -> None:
        while True:
            with self.lock:
                while not self.queue and not self._stop:
                    self.wake.wait()
                if self._stop:
                    return
                j = self.jobs[self.queue.pop(0)]
                j.state, j.started = "running", time.time()
                j.plan = {s: self._expect(s, j.cond) for s in j.stages}
            self._run(j)

    def _run(self, j: Job) -> None:
        folder = self.out / j.key
        folder.mkdir(parents=True, exist_ok=True)
        ctx = JobContext(self, j, folder)
        try:
            for s in j.stages:
                with self.lock:
                    j.stage, j.stage_progress = s, 0.0
                    self._stage_t0 = self.clock()
                ctx.check()
                self._progress(j, 0.0)
                self.stage_fns[s](ctx)
                spent = self.clock() - self._stage_t0
                sc = self._scale(s, j.cond)
                if sc > 0:  # 저장해 둔 결과만 쓴 단계(배수 0)는 배우지 않는다
                    self.est.learn(s, j.cond["duration"], spent / sc)
                if s == "transient" and (folder / "preview.json").exists():
                    j.preview = True
                self._progress(j, 1.0)
            with self.lock:
                j.state, j.progress, j.eta_s, j.stage, j.finished = "done", 1.0, 0.0, None, time.time()
        except Cancelled:
            with self.lock:
                j.state, j.eta_s, j.finished = "cancelled", None, time.time()
        except Exception as e:  # noqa: BLE001
            with self.lock:
                j.state, j.eta_s, j.error, j.finished = "failed", None, f"{type(e).__name__}: {e}"[:400], time.time()
        self._emit(j.public())
        self._prune()

    def _prune(self) -> None:
        dirs = sorted((p for p in self.out.iterdir() if p.is_dir() and (p / "result.json").exists()), key=lambda p: p.stat().st_mtime)
        for p in dirs[: max(0, len(dirs) - self.max_keep)]:
            for f in p.iterdir():
                f.unlink(missing_ok=True)
            p.rmdir()
