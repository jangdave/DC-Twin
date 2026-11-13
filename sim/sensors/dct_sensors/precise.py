"""정확한 시뮬레이션 작업의 단계들 (docs/31 4.1, docs/32 V4).

구성: 조건 → USD 조건 층(`job.usda`, 계산은 이 층을 다시 읽음) → 팬 상태마다 OpenFOAM이 공기 흐름을 푼다(약 10분, WSL)
→ 우리 온도 계산(열 보존 fv, 다공질 랙, OpenFOAM 난류 확산)이 그 흐름으로 시간 변화와 센서 값을 낸다 → 웹 녹화.

V4-3에서 같은 흐름, 같은 랙 가정이면 우리 온도 계산이 OpenFOAM 온도를 RMSE 0.07~0.73도로 다시 내는 것을 확인했다.
`precise=False`이면 OpenFOAM 없이 보정 모델(L2)로 바로 계산한다(빠른 미리보기).

필요한 것: Warp, pxr(Kit 또는 experiments/omniverse_probe 환경), WSL의 OpenFOAM(v1912), `uv`. 시각화 목적이며 공학적 정확성을 주장하지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from . import jobs
from .config import Config
from .generator import Generator
from .manifest import Manifest
from .solvers import Controls

REPO = Path(__file__).resolve().parents[3]
OMNI = REPO / "experiments" / "omniverse_probe"
OFB = REPO / "experiments" / "openfoam_baseline"
SCENE = REPO / "usd" / "scenes" / "hall01.usda"
NU, PR, PRT = 1.5e-5, 0.71, 0.85  # OpenFOAM 사례와 같은 값(공기 점성, 프란틀 수, 난류 프란틀 수)
EXPECTED_ITERS = 2000  # OpenFOAM 반복 수 추정(10 cm, 실제 1,077~1,849회: openfoam_baseline/README.md)


def wsl_path(p: Path) -> str:
    p = Path(p).resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def eq_name(n: str) -> str:
    """crac_02 -> CRAC_02, rack_05 -> Rack_05 (장면 prim 이름)."""
    a, b = n.split("_")
    return f"{'CRAC' if a == 'crac' else 'Rack'}_{b}"


def fan_states(cond: dict) -> list[tuple[int, dict]]:
    """시간 순서대로 (시작 초, 팬 상태). 0초 상태와 고장 시각마다 바뀐 상태."""
    fan = dict(cond["fans"])
    out = [(0, dict(fan))]
    for f in cond["failures"]:
        fan[f["crac"]] = 0.0
        if out[-1][0] == f["t"]:
            out[-1] = (f["t"], dict(fan))
        else:
            out.append((f["t"], dict(fan)))
    return out


def flow_key(fan: dict, rack_kw: dict, scene: str | None = None) -> str:
    d = {"fan": {k: round(v, 3) for k, v in sorted(fan.items())}, "kw": {k: round(v, 2) for k, v in sorted(rack_kw.items())}}
    if scene:
        d["scene"] = scene  # 기본 장면이 아니면 키에 넣는다(기본 장면의 키는 예전과 같게)
    blob = json.dumps(d, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def mean_rack_power(manifest: Manifest, cfg: Config, cond: dict, seed: int = 1) -> dict:
    """작업 녹화와 같은 시드의 랙별 평균 전력(kW, 출렁임 제외) x 조건의 배수. OpenFOAM은 정상 상태라 평균 전력을 쓴다."""
    g = Generator(manifest, jobs.scenario_from_conditions(cond), None, cfg, seed=seed)
    scale = {r: 1.0 for r in manifest.rack_names}
    for k, v in cond["power"].items():
        if k.startswith("row:"):
            for r, (row, _) in manifest.racks.items():
                if row == int(k[4:]) and r not in cond["power"]:
                    scale[r] = v
        else:
            scale[k] = v
    return {eq_name(r): round(g.base_power[r] * scale[r], 3) for r in manifest.rack_names}


def scene_tag(scene: Path | None) -> str | None:
    """흐름 저장 키에 넣는 장면 표시. 이중 바닥이 없는 장면은 예전 키 그대로(기본 장면은 None, 다른 장면은 이름),
    있으면 이름 + 바닥 아래 구성(깊이, 타일, 받침 기둥, 장애물 prim)의 지문. 기본 장면(hall01.usda)에 이중 바닥을 켠 뒤
    (2026-11-11, docs/33 C단계) 예전(바닥 아래 공간 없음) 흐름을 잘못 쓰지 않게 한다. USD 라이브러리 없이 글자로 읽는다(서버 환경에 scipy·pxr이 없을 수 있음)."""
    sc = Path(scene or SCENE)
    text = sc.read_text(encoding="utf-8", errors="replace") if sc.suffix == ".usda" else ""
    if "dct:plenumDepthCm" not in text:
        return sc.stem if scene and sc.resolve() != SCENE.resolve() else None
    lines = [ln.strip() for ln in text.splitlines() if re.search(r"dct:(plenumDepth|floorThickness|tileOpenRatio|pedestal)", ln)]
    k = text.find('def "Underfloor"')
    if k >= 0:  # 장애물 묶음(중괄호 짝까지)
        depth, e = 0, text.index("{", k)
        for e in range(e, len(text)):
            depth += {"{": 1, "}": -1}.get(text[e], 0)
            if depth == 0:
                break
        lines.append(re.sub(r"\s+", " ", text[k:e]))
    return f"{sc.stem}:{hashlib.sha256(chr(10).join(lines).encode()).hexdigest()[:8]}"


class OpenFOAMRunner:
    """팬 상태 하나의 공기 흐름을 OpenFOAM으로 풀어 우리 격자 `.npz`로 둔다. 같은 조건이면 저장해 둔 것을 쓴다."""

    def __init__(self, cache: Path, cores: int = 16, uv: str = "uv", wsl: str = "wsl"):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.cores, self.uv, self.wsl = cores, uv, wsl

    def _wsl(self, cmd: str, **kw) -> subprocess.CompletedProcess:
        return subprocess.run([self.wsl, "-e", "bash", "-lc", cmd], capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)

    def flow(self, fan: dict, rack_kw: dict, progress=lambda f, note=None: None, check=lambda: None, scene: Path | None = None) -> tuple[Path, dict]:
        """scene: 다른 장면(예: 이중 바닥을 켠 _hall01_rf.usda)으로 풀 때. 저장 키에 장면 이름이 들어간다."""
        key = flow_key(fan, rack_kw, scene_tag(scene))
        npz = self.cache / f"{key}.npz"
        meta_p = self.cache / f"{key}.json"
        if npz.exists() and meta_p.exists():
            progress(1.0, "저장해 둔 흐름")
            return npz, json.loads(meta_p.read_text(encoding="utf-8"))
        name = f"job_{key}"
        case = OFB / "cases" / name
        spec = self.cache / f"{key}.spec.json"
        spec.write_text(json.dumps({"id": name, "fan": {eq_name(k): v for k, v in fan.items()}, "row_power_kw": [10.0] * 6,
                                    "rack_power_kw": rack_kw, "remove": []}, ensure_ascii=False), encoding="utf-8")
        t0 = time.time()
        progress(0.0, "사례 만들기")
        r = subprocess.run([self.uv, "run", "--python", "3.13", "python", str(OFB / "gen_case.py"), "--spec", str(spec), "--out", str(case), *(["--scene", str(Path(scene).resolve())] if scene else [])],
                           cwd=OMNI, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError(f"OpenFOAM 사례 만들기 실패: {r.stderr[-400:]}")
        proc = subprocess.Popen([self.wsl, "-e", "bash", wsl_path(OFB / "run_case.sh"), name, str(self.cores)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        it = 0
        try:
            while proc.poll() is None:
                try:
                    check()
                except jobs.Cancelled:
                    proc.kill()
                    self._wsl("pkill -f buoyantBoussinesqSimpleFoam; pkill -f mpirun")
                    raise
                tail = self._wsl(f"tail -c 4000 ~/foam_runs/{name}/log.solver 2>/dev/null").stdout
                found = re.findall(r"^Time = (\d+)", tail, re.M)
                if found:
                    it = int(found[-1])
                    progress(min(0.05 + 0.9 * it / EXPECTED_ITERS, 0.95), f"반복 {it}")
                time.sleep(5)
            log = self._wsl(f"tail -c 20000 ~/foam_runs/{name}/log.solver").stdout
            converged = "SIMPLE solution converged" in log
            found = re.findall(r"^Time = (\d+)", log, re.M)
            it = int(found[-1]) if found else it
            progress(0.96, "흐름 꺼내기")
            r = self._wsl(f"python3 {wsl_path(OFB / 'export_flow.py')} ~/foam_runs/{name} {wsl_path(npz)}")
            if r.returncode != 0 or not npz.exists():
                raise RuntimeError(f"OpenFOAM 흐름 꺼내기 실패(반복 {it}): {(r.stderr or r.stdout)[-400:]}")
            meta = {"key": key, "iterations": it, "converged": converged, "seconds": round(time.time() - t0, 1), "fan": fan, "rack_kw": rack_kw}
            meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            return npz, meta
        finally:
            self._wsl(f"rm -rf ~/foam_runs/{name}")
            shutil.rmtree(case, ignore_errors=True)
            spec.unlink(missing_ok=True)


class CFDSolver:
    """센서 생성기(Generator)용 모델: OpenFOAM 흐름(팬 상태마다)으로 우리 온도 계산(fv, 다공질 랙)을 돌린다.

    팬 상태가 바뀌면 그 상태의 흐름으로 한 번에 바꾼다(흐름이 바뀌는 과정은 없다). 응답 속도는 L1과 같은 조절값 slow를 쓴다."""

    def __init__(self, manifest: Manifest, cfg: Config, flows: dict, slow: float = 10.0, warmup_s: float = 120.0, scene: Path | None = None):
        sys.path.insert(0, str(OMNI))
        import hall60_sim as hs
        import warp as wp

        wp.config.quiet = True
        wp.init()
        self.hs, self.cfg, self.m, self.flows = hs, cfg, manifest, flows
        hs.DX = 0.10
        hall = hs.read_hall(scene or SCENE)
        self.lay = hs.porous_rack_layout(hs.Layout(hall))
        self.sim = hs.Sim(hall, self.lay, cfg.power_ref, slow, t_supply=cfg.t_supply, advection="fv")
        self.rack_names = [r["name"].lower() for r in hall["racks"]]
        self.crac_names = [c["name"].lower() for c in hall["cracs"]]
        self.anchors, self.keys = [], []
        for a in hall["anchors"]:
            eq = a["equipment"].lower()
            if eq in self.rack_names and a["metric"] in ("temp_in", "temp_out"):
                self.anchors.append(a)
                self.keys.append(f"{eq}/{a['metric']}")
        self.ret_cells = [np.argwhere(self.lay.ret_id == i) for i in range(len(self.crac_names))]
        self.fan = None
        self._power = None
        self.flow_switches = 0
        self._use({c: 1.0 for c in self.crac_names} if not flows else next(iter(flows.values()))["fan"])
        self.warmup_s = self._warm(warmup_s)

    def _warm(self, min_s: float, max_s: float = 4000.0, window_s: float = 600.0, tol: float = 0.02) -> float:
        """시작 상태(첫 팬 상태)의 정상 상태까지 예열한다(센서 값은 내보내지 않음). V1과 같은 판정:
        랙 입구가 모의 600초(조절값 10이면 물리 60초) 동안 0.02도 안쪽으로만 변하면 끝. 처음 판(L1처럼 120초)은
        초기 온도 24도가 아직 남아 기록 앞부분이 실제보다 뜨거웠다(2026-11-10 첫 실제 작업)."""
        per = max(1, int(round(10.0 / self.sim.dt_phys)))  # 모의 10초
        hist, t = [], 0.0
        while t < max_s:
            for _ in range(per):
                self.sim.step()
            t += 10.0
            hist.append(self.sim.sensors(self.anchors))
            k = int(window_s / 10)
            if t >= max(min_s, window_s) and len(hist) > k and float(np.abs(hist[-1] - hist[-1 - k]).max()) < tol:
                break
        return t

    @staticmethod
    def fan_tuple(fan: dict) -> tuple:
        return tuple(round(float(fan[k]), 3) for k in sorted(fan))

    def _use(self, fan: dict) -> None:
        key = self.fan_tuple(fan)
        f = self.flows.get(key)
        if f is None:
            raise RuntimeError(f"이 팬 상태의 흐름이 없다: {key}")
        z = np.load(f["npz"])
        vec = np.array([fan[c] for c in self.crac_names], dtype=np.float32)
        self.sim.set_flow_field(vec, z["U"].astype(np.float64), NU / PR + z["nut"].astype(np.float64) / PRT)
        self.fan = key
        self.flow_switches += 1

    def set_supply(self, value: float) -> None:
        self.sim.t_supply = float(value)

    def step(self, dt: float, controls: Controls) -> dict[str, float]:
        fan = {c: float(controls.fan.get(c, 1.0)) for c in self.crac_names}
        if self.fan_tuple(fan) != self.fan:
            self._use(fan)
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
            out[f"{c}/supply_temp"] = self.cfg.t_supply + self.cfg.crac_supply_rise * (1.0 - fan[c])
        return out


def steady_runs_needed(manifest: Manifest, cache: Path, seed: int = 1, scene: Path | None = None):
    """정확한 계산의 OpenFOAM 단계 배수: 저장해 둔 흐름이 없는 팬 상태의 수(남은 시간 추정용, jobs.JobManager stage_scale).
    저장 키는 OpenFOAMRunner.flow와 같게 장면 표시를 넣는다(빠지면 이중 바닥 장면에서 저장된 흐름을 늘 "없음"으로 센다, 2026-11-13 재검토)."""
    tag = scene_tag(scene)

    def count(cond: dict) -> float:
        cfg = Config()
        cfg.t_supply = cond["supply"]
        kw = mean_rack_power(manifest, cfg, cond, seed)
        return float(sum(1 for _, fan in fan_states(cond) if not (Path(cache) / f"{flow_key(fan, kw, tag)}.npz").exists()))
    return count


def make_stages(manifest: Manifest, *, runner: OpenFOAMRunner | None = None, seed: int = 1, solver_factory=None, scene: Path = SCENE) -> dict:
    """jobs.JobManager에 넣을 단계 함수들. solver_factory(cond, flows, cfg)를 주면 계산 모델을 바꿀 수 있다(시험용)."""
    sensor_ids = [s.sensor_id for s in manifest.sensors]

    def cfg_for(cond):
        cfg = Config()
        cfg.t_supply = cond["supply"]
        return cfg

    def usd(ctx):
        text = jobs.conditions_to_usda(ctx.cond, manifest, scene.as_posix())
        p = ctx.folder / "job.usda"
        p.write_text(text, encoding="utf-8")
        ctx.data["cond"] = jobs.conditions_from_usd(p, manifest)  # 계산은 USD 층에서 다시 읽은 조건을 쓴다
        if ctx.data["cond"] != ctx.cond:
            raise RuntimeError("USD 층에서 읽은 조건이 보낸 조건과 다르다")
        (ctx.folder / "conditions.json").write_text(json.dumps(ctx.cond, ensure_ascii=False, indent=1), encoding="utf-8")
        ctx.progress(1.0)

    def steady(ctx):
        cond = ctx.data["cond"]
        kw = mean_rack_power(manifest, cfg_for(cond), cond, seed)
        states = fan_states(cond)
        flows = {}
        for i, (t, fan) in enumerate(states):
            def prog(f, note=None, i=i):
                ctx.progress((i + f) / len(states))
            npz, meta = (runner or OpenFOAMRunner(ctx.manager.out / "flows")).flow(fan, kw, prog, ctx.check, scene=scene)
            flows[CFDSolver.fan_tuple({k: fan[k] for k in fan})] = {"npz": str(npz), "fan": fan, "meta": meta, "from_s": t}
            if not meta.get("converged"):
                ctx.note(f"OpenFOAM이 수렴 판정을 통과하지 못했다(팬 상태 {i + 1}, 반복 {meta.get('iterations')}). 값은 마지막 반복의 흐름이다")
        ctx.data["flows"] = flows
        (ctx.folder / "flows.json").write_text(json.dumps([{k: v for k, v in f.items() if k != "npz"} for f in flows.values()], ensure_ascii=False, indent=1), encoding="utf-8")

    def transient(ctx):
        cond = ctx.data["cond"]
        cfg = cfg_for(cond)
        if solver_factory is not None:
            solver = solver_factory(cond, ctx.data.get("flows"), cfg)
        elif ctx.data.get("flows"):
            solver = CFDSolver(manifest, cfg, ctx.data["flows"], scene=scene)
        else:
            from .solvers import make_solver
            solver = make_solver("l2", manifest, cfg)
        gen = Generator(manifest, jobs.scenario_from_conditions(cond), solver, cfg, seed=seed)
        msgs = []
        dur = cond["duration"]
        t0 = None
        last = -1
        for m in gen.run(dur):
            msgs.append(m)
            ms = jobs.datetime_ms(m["ts"])
            t0 = ms if t0 is None else t0
            t = int(round((ms - t0) / 1000))
            if t != last and t % 5 == 0:
                last = t
                ctx.check()
                ctx.progress(min(t / dur, 0.99))
        rec = jobs.to_web_recording(msgs, "job", sensor_ids)
        rec["meta"] = {**rec.get("meta", {}), "job": {"key": ctx.job.key, "precise": cond["precise"], "model": "openfoam_flow+fv" if ctx.data.get("flows") else "l2",
                                                       "warmup_s": getattr(solver, "warmup_s", None)}}
        (ctx.folder / "preview.json").write_text(json.dumps(rec, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        ctx.data["rec"] = rec

    def result(ctx):
        shutil.copyfile(ctx.folder / "preview.json", ctx.folder / "result.json")
        ctx.progress(1.0)

    return {"usd": usd, "steady": steady, "transient": transient, "result": result}


def main(argv: list[str] | None = None) -> int:
    r"""작업 하나를 명령줄에서 돌린다(서버 없이 확인할 때). experiments/omniverse_probe 환경에서:

        set PYTHONPATH=..\..\sim\sensors
        uv run --python 3.13 python -m dct_sensors.precise --conditions cond.json [--out ..\..\sim\out\jobs]
    """
    import argparse

    from .manifest import load_manifest

    ap = argparse.ArgumentParser()
    ap.add_argument("--conditions", type=Path, required=True)
    ap.add_argument("--manifest", type=Path, default=REPO / "server" / "data" / "sensor_manifest.json")
    ap.add_argument("--out", type=Path, default=REPO / "sim" / "out" / "jobs")
    a = ap.parse_args(argv)
    m = load_manifest(a.manifest)
    mgr = jobs.JobManager(m, a.out, make_stages(m), stage_scale={"steady": steady_runs_needed(m, a.out / "flows")})
    last = [None]

    def show(s):
        line = f"{s['state']:9s} {s.get('stageTitle') or '':28s} {s['progress'] * 100:5.1f}%  남은 시간 {s['etaS'] if s['etaS'] is not None else '-'}초"
        if line != last[0]:
            last[0] = line
            print(line, flush=True)

    mgr.listeners.append(show)
    j = mgr.submit(json.loads(a.conditions.read_text(encoding="utf-8")))
    while mgr.status(j["id"])["state"] in ("queued", "running"):
        time.sleep(1)
    st = mgr.status(j["id"])
    print(json.dumps({k: st[k] for k in ("state", "error", "notes", "cached", "key")}, ensure_ascii=False))
    mgr.stop()
    return 0 if st["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
