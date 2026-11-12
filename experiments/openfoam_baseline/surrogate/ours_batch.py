"""샘플 명세(samples.json)의 모든 샘플(보류 A, B, D, E 포함)을 현재 main의 hall60_sim으로 돌려 랙 입구 온도를 저장한다.

실행 (experiments/omniverse_probe 폴더에서, GPU 사용):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/ours_batch.py [--force] [--only s01_normal ...]
출력: results/surrogate/ours_<id>.csv (열: rack_id, temp_c), ours_progress.json

조건은 compare.py와 같다: 처음 120초는 팬 1.0, 랙 10 kW 균일(제거할 랙은 처음부터 장면에서 뺀다),
121초부터 샘플 명세의 팬 레벨(Sim.set_fans)과 줄별 전력(Sim.set_power)을 적용하고, 정상(팬 전부 1.0, 전력 10 kW 균일)은 600초, 나머지는 900초까지 돌려 마지막 시각의 센서 temp_in(랙 앞면 5 cm 앞, 높이 1.2 m)을 쓴다.
hall60_sim.main()의 시간 루프와 같은 방식이다(hall60_sim.py는 읽기만 하고 수정하지 않는다).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RES = HERE.parent / "results" / "surrogate"
sys.path.insert(0, str(HERE.parents[1] / "omniverse_probe"))
import hall60_sim as h  # noqa: E402
import layout_whatif as lw  # noqa: E402
import warp as wp  # noqa: E402

FAIL_TIME = 120


def run_sample(smp: dict) -> dict:
    base = h.ROOT / "usd" / "scenes" / "hall01.usda"
    scene, tmp = base, None
    if smp["remove"]:
        tmp = Path(tempfile.gettempdir()) / f"dct_ours_{smp['id']}.usda"
        lw.apply_edits(base, tmp, {"remove": smp["remove"]})
        scene = tmp
    hall = h.read_hall(scene)
    lay = h.Layout(hall)
    names = [c["name"] for c in hall["cracs"]]
    sim = h.Sim(hall, lay, 10.0, 10.0, advection="fv" if hall.get("plenum") else "maccormack")  # 센서 생성기(solver_l1)와 같은 선택
    fan = np.ones(len(names), dtype=np.float32)
    sim.set_fans(fan)
    target_fan = np.array([smp["fan"][n] for n in names], dtype=np.float32)
    target_kw = np.array([smp["row_power_kw"][(int(r["name"].split("_")[1]) - 1) // 10] for r in hall["racks"]], dtype=np.float32)
    unchanged = bool((target_fan == 1.0).all() and (target_kw == 10.0).all())
    duration = 600 if unchanged else 900
    anc = sorted([a for a in hall["anchors"] if a["equipment"].startswith("Rack_") and a["metric"] == "temp_in"], key=lambda a: a["equipment"])
    steps_per_s = int(round(1.0 / sim.dt_phys))
    t0 = time.time()
    for s in range(1, duration + 1):
        if s == FAIL_TIME + 1:  # hall60_sim.main()이 고장을 거는 시점과 같다
            fan = target_fan
            sim.set_fans(fan)
            sim.set_power(target_kw)
        for _ in range(steps_per_s):
            sim.step()
    vals = sim.sensors(anc)
    if tmp is not None:
        tmp.unlink(missing_ok=True)
    return {"temps": {a["equipment"]: float(v) for a, v in zip(anc, vals)}, "duration_s": duration, "wall_s": round(time.time() - t0, 1),
            "supply_m3s": sim.flow_info.get("supply_m3s"), "aisle_leak_m3s": sim.flow_info.get("aisle_leak_m3s")}


def main() -> None:
    global RES
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--res", type=Path, default=RES, help="결과 폴더(이중 바닥 장면은 results/surrogate_rf)")
    a = ap.parse_args()
    RES = a.res
    wp.config.quiet = True
    wp.init()
    RES.mkdir(parents=True, exist_ok=True)
    samples = json.loads((HERE / "samples.json").read_text(encoding="utf-8"))["samples"]
    sha = hashlib.sha1((h.HERE / "hall60_sim.py").read_bytes()).hexdigest()[:12]
    prog_p = RES / "ours_progress.json"
    prog = json.loads(prog_p.read_text(encoding="utf-8")) if prog_p.exists() else {}
    for smp in samples:
        sid = smp["id"]
        if a.only and sid not in a.only:
            continue
        out = RES / f"ours_{sid}.csv"
        if out.exists() and not a.force:
            continue
        r = run_sample(smp)
        out.write_text("rack_id,temp_c\n" + "".join(f"{k},{v:.3f}\n" for k, v in sorted(r["temps"].items())), encoding="utf-8")
        prog[sid] = {"status": "done", "duration_s": r["duration_s"], "wall_s": r["wall_s"], "supply_m3s": r["supply_m3s"], "aisle_leak_m3s": r["aisle_leak_m3s"],
                     "hall60_sim_sha1": sha, "mean": round(float(np.mean(list(r["temps"].values()))), 2), "max": round(float(max(r["temps"].values())), 2)}
        prog_p.write_text(json.dumps(prog, indent=1, ensure_ascii=False), encoding="utf-8")
        print(sid, prog[sid], flush=True)


if __name__ == "__main__":
    main()
