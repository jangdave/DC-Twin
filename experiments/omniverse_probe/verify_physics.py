"""V1 물리 점검 (docs/32 4장). 우리 열 계산(`hall60_sim`)이 기준 답 없이도 지켜야 할 것을 확인한다.

① 열 수지: 정상 상태에서 랙 발열의 합 = CRAC 회수구로 나가는 열(Σ q_i ρcp (T_회수,i − T_급기)). 차이가 1 % 안쪽이어야 한다.
   (방은 닫혀 있다. 지붕 틈으로 샌 뜨거운 공기도 결국 CRAC로 돌아간다. 벽은 단열이다.)
② 정상 상태 도달: 마지막 60초 동안 랙 입구 온도가 0.05도 안쪽으로만 변한다.
③ 격자 수렴: 격자 간격 20, 10, 5 cm에서 랙 입구 온도가 어떻게 바뀌는지(10 cm 대비 RMSE와 최대 차이).

Kit 안(`kit/kit_verify_physics.py`)과 독립 실행 모두에서 돈다. 시각화 목적이며 공학적 정확성을 주장하지 않는다.

    uv run --python 3.13 python verify_physics.py [--dx 0.2 0.1 0.05] [--cases normal crac02_off crac02_06_off] [--out out/verify/v1]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import hall60_sim as hs

CASES = {"normal": [], "crac02_off": ["CRAC_02"], "crac02_06_off": ["CRAC_02", "CRAC_06"]}
POWER_KW = 10.0
WINDOW_S = 600  # 모의 600초 = 물리 60초(조절값 10). 첫 실행은 60(물리 6초)이라 판정이 너무 느슨했다
STEADY_TOL = 0.02
MAX_S = 8000
SLOW = 10.0  # 실제로 쓰는 조절값(hall60_sim 기본). 1이면 10 cm에서 값이 발산했다(V1 첫 실행, 2026-11-10)


def heat_out_kw(sim: "hs.Sim", lay: "hs.Layout", T: np.ndarray) -> tuple[float, list[float]]:
    """CRAC 회수구로 나가는 열(kW). 회수 칸의 평균 온도와 회수 유량으로 계산한다."""
    q = sim.flow_info["crac_return_m3s"]
    out, t_ret = 0.0, []
    for i, qi in enumerate(q):
        cells = lay.ret_id == i
        tr = float(T[cells].mean()) if cells.any() else float("nan")
        t_ret.append(round(tr, 3))
        if qi > 0:
            out += qi * hs.RHO_CP * (tr - sim.t_supply)
    return out, t_ret


def run_case(hall: dict, fail: list[str], dx: float, device: str = "cuda:0", slow: float = SLOW, advection: str = "maccormack", flow_npz: Path | None = None,
             turb: bool = False, porous: bool = False) -> dict:
    hs.DX = dx  # Layout, Sim, 흐름 계산이 모듈의 DX를 읽는다
    t0 = time.time()
    lay = hs.Layout(hall)
    if porous:
        lay = hs.porous_rack_layout(lay)  # OpenFOAM처럼 랙을 공기가 지나가는 칸으로(받은 흐름과 함께)
    names = [c["name"] for c in hall["cracs"]]
    sim = hs.Sim(hall, lay, POWER_KW, slow=slow, device=device, advection=advection)
    fan = np.ones(len(names), dtype=np.float32)
    for n in fail:
        fan[names.index(n)] = 0.0
    if flow_npz is not None:  # 받은 흐름(OpenFOAM)으로 온도만 푼다(V4-2)
        z = np.load(flow_npz)
        k = (1.5e-5 / 0.71 + z["nut"] / 0.85) if turb else None  # 분자 확산 + 난류 확산(난류 프란틀 수 0.85, OpenFOAM 사례와 같은 값)
        sim.set_flow_field(fan, z["U"].astype(np.float64), k)
    else:
        sim.set_fans(fan)
    flow_s = time.time() - t0
    racks = [r["name"] for r in hall["racks"]]
    anc = sorted((a for a in hall["anchors"] if a["equipment"].startswith("Rack_") and a["metric"] == "temp_in"), key=lambda a: a["equipment"])
    assert [a["equipment"] for a in anc] == racks, "랙마다 입구 앵커가 하나씩 있어야 한다"
    steps = int(round(1.0 / sim.dt_phys))
    hist: list[np.ndarray] = []
    energy: list[float] = []  # 방 안 공기의 열(kJ, 기준 0도): 10초마다
    fluid = lay.fluid
    cell_kj = hs.RHO_CP * hs.DX ** 3
    t = 0
    steady_at = None
    while t < MAX_S:
        for _ in range(steps):
            sim.step()
        t += 1
        if t % 10 == 0:
            hist.append(sim.sensors(anc).astype(np.float64))
            energy.append(cell_kj * float(sim.T.numpy()[fluid].astype(np.float64).sum()))
            if not np.isfinite(hist[-1]).all():
                break  # 발산(값이 무한대나 NaN)
            if t >= WINDOW_S + 10 and len(hist) > WINDOW_S // 10:
                drift = float(np.abs(hist[-1] - hist[-1 - WINDOW_S // 10]).max())
                if drift < STEADY_TOL:
                    steady_at = t
                    break
    inlet = hist[-1]
    drift = float(np.abs(hist[-1] - hist[-1 - WINDOW_S // 10]).max()) if len(hist) > WINDOW_S // 10 else None
    T = sim.T.numpy()
    q_out, t_ret = heat_out_kw(sim, lay, T)
    # 방에 쌓이는 열(kW): 마지막 100초(모의) 동안의 변화 / 그동안의 물리 시간
    k = min(10, len(energy) - 1)
    store_kw = (energy[-1] - energy[-1 - k]) / (k * 10 / slow) if k > 0 else float("nan")
    p_in = POWER_KW * len(racks)
    diverged = not np.isfinite(inlet).all()
    return {
        "dx_m": dx, "slow": slow, "advection": advection, "substeps": sim.flow_info.get("fv_substeps", 1), "diverged": diverged, "grid": list(lay.shape), "cells": int(np.prod(lay.shape)), "fluid_cells": int(lay.fluid.sum()),
        "dt_phys_s": sim.dt_phys, "flow": {k: sim.flow_info.get(k) for k in ("supply_m3s", "rack_m3s", "aisle_leak_m3s", "crac_return_m3s", "residual", "solve_s", "proj_residual", "div_mismatch_before_1s", "flow", "k_max", "k_mean")},
        "sim_seconds": t, "steady": steady_at is not None, "steady_at_s": steady_at, "last60_max_change_C": None if drift is None else round(drift, 4),
        "heat_in_kw": round(p_in, 2), "heat_out_kw": round(q_out, 2), "heat_balance_pct": round(100.0 * (q_out - p_in) / p_in, 3),
        "stored_kw": round(store_kw, 2), "numerical_gap_pct": round(100.0 * (p_in - q_out - store_kw) / p_in, 3),
        "crac_return_C": t_ret, "rack_inlet_C": {n: round(float(v), 3) for n, v in zip(racks, inlet)},
        "inlet_mean_C": round(float(inlet.mean()), 3), "inlet_max_C": round(float(inlet.max()), 3),
        "wall_s": round(time.time() - t0, 1), "flow_wall_s": round(flow_s, 1),
    }


def grid_compare(results: dict) -> dict:
    """같은 조건에서 격자별 랙 입구 온도를 10 cm와 비교한다."""
    out = {}
    for case, by_dx in results.items():
        ref = by_dx.get("0.1")
        if not ref or ref.get("diverged"):
            continue
        rv = np.array(list(ref["rack_inlet_C"].values()))
        for dx, r in by_dx.items():
            if dx == "0.1" or r.get("diverged"):
                continue
            v = np.array(list(r["rack_inlet_C"].values()))
            d = v - rv
            out.setdefault(case, {})[dx] = {"rmse_C": round(float(np.sqrt((d ** 2).mean())), 3), "max_abs_C": round(float(np.abs(d).max()), 3),
                                            "bias_C": round(float(d.mean()), 3), "mean_C": round(float(v.mean()), 3), "max_C": round(float(v.max()), 3)}
    return out


def report_md(res: dict) -> str:
    L = ["# V1 물리 점검 결과", "", f"- 실행: {res['env']}", f"- 조건: 랙 {POWER_KW:g} kW 균일, 급기 {hs.T_SUPPLY:g}도, 조절값(slow) {SLOW:g}(모의 1초 = 물리 {1 / SLOW:g}초), 정상 상태 판정은 마지막 {WINDOW_S}초 변화 {STEADY_TOL}도 미만(최대 {MAX_S}초)", ""]
    L += ["## 열 수지와 정상 상태", "", "| 조건 | 격자 | 칸 수 | 정상 도달(초) | 마지막 600초(물리 60초) 변화 | 랙 발열 kW | CRAC로 나간 열 kW | 차이 % | 방에 쌓이는 열 kW | 설명 안 되는 차이 % | 입구 평균 / 최고 | 계산 시간 |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for case, by_dx in res["cases"].items():
        for dx, r in by_dx.items():
            L.append(f"| {case} | {float(dx) * 100:g} cm | {r['cells']:,} | {'발산' if r.get('diverged') else (r['steady_at_s'] if r['steady'] else '도달 못 함')} | {r['last60_max_change_C']} | {r['heat_in_kw']} | {r['heat_out_kw']} | {r['heat_balance_pct']:+.2f} | {r['stored_kw']} | {r['numerical_gap_pct']:+.2f} | {r['inlet_mean_C']} / {r['inlet_max_C']} | {r['wall_s']}초 |")
    L += ["", "## 격자에 따른 랙 입구 온도 (10 cm 대비)", "", "| 조건 | 격자 | RMSE | 최대 차이 | 평균 차이 | 평균 / 최고 |", "|---|---|---|---|---|---|"]
    for case, by_dx in res["grid"].items():
        for dx, g in by_dx.items():
            L.append(f"| {case} | {float(dx) * 100:g} cm | {g['rmse_C']} | {g['max_abs_C']} | {g['bias_C']:+} | {g['mean_C']} / {g['max_C']} |")
    return "\n".join(L) + "\n"


def main(argv: list[str] | None = None, env: str = "독립 실행") -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dx", type=float, nargs="*", default=[0.2, 0.1, 0.05])
    ap.add_argument("--cases", nargs="*", default=list(CASES))
    ap.add_argument("--scene", type=Path, default=hs.ROOT / "usd" / "scenes" / "hall01.usda")
    ap.add_argument("--slow", type=float, default=SLOW)
    ap.add_argument("--advection", choices=["maccormack", "linear", "fv"], default="maccormack")
    ap.add_argument("--flow-prefix", default="", help="--flow-dir 안의 흐름 파일 이름 앞에 붙는 말(예: rf_ -> rf_normal_dx10.npz)")
    ap.add_argument("--porous", action="store_true", help="--flow-dir와 함께: 랙을 OpenFOAM처럼 다공질(공기가 지나가는 칸 + 부피 발열)로")
    ap.add_argument("--turb", action="store_true", help="--flow-dir와 함께: OpenFOAM 난류 점성으로 확산 계수를 칸마다 정한다")
    ap.add_argument("--flow-dir", type=Path, default=None, help="OpenFOAM 흐름(.npz, export_flow.py) 폴더. 주면 조건마다 <조건>_dx10.npz의 흐름으로 온도만 푼다(fv, 10 cm)")
    ap.add_argument("--out", type=Path, default=hs.HERE / "out" / "verify" / "v1")
    a = ap.parse_args(argv)
    import warp as wp

    wp.config.quiet = True
    wp.init()
    hall = hs.read_hall(a.scene)
    res = {"env": f"{env}, Warp {wp.__version__}, 이류 {a.advection}", "cases": {}}
    a.out.mkdir(parents=True, exist_ok=True)
    for case in a.cases:
        for dx in a.dx:
            fnpz = (a.flow_dir / f"{a.flow_prefix}{case}_dx10.npz") if a.flow_dir else None
            r = run_case(hall, CASES[case], dx, slow=a.slow, advection=a.advection, flow_npz=fnpz, turb=a.turb, porous=a.porous)
            res["cases"].setdefault(case, {})[f"{dx:g}"] = r
            print(f"[V1] {case} dx={dx:g}: 정상 {r['steady_at_s']}s, 열 수지 {r['heat_balance_pct']:+.2f}%, 입구 평균 {r['inlet_mean_C']} 최고 {r['inlet_max_C']}, {r['wall_s']}s", flush=True)
            (a.out / "v1_result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")  # 중간에도 저장
    hs.DX = 0.10
    res["grid"] = grid_compare(res["cases"])
    (a.out / "v1_result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    (a.out / "v1_report.md").write_text(report_md(res), encoding="utf-8")
    return res


if __name__ == "__main__":
    main()
