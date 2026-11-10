"""웹 보기용 공기 흐름을 OpenFOAM 결과로 만든다 (docs/32 V4, 사용자 요청 2026-11-10: 격벽 위 공간의 순환이 보이게).

export_web_flow.py와 같은 형식(정상 1개 + CRAC 1대씩 멈춘 8개, 20 cm, int8)인데, 흐름을 우리 퍼텐셜 흐름 대신
OpenFOAM(난류, 부력, 다공질 랙)으로 푼다. 랙 전력은 10 kW 균일(기존 기준 사례와 같음). 흐름은 정확한 시뮬레이션 작업과
같은 저장소(`sim/out/jobs/flows`)에 두므로 같은 조건이면 다시 계산하지 않는다(처음에는 9번, 약 1시간).

사용 (이 폴더에서, WSL에 OpenFOAM 필요):
    set PYTHONPATH=..\\..\\sim\\sensors
    uv run --python 3.13 python export_web_flow_of.py [--out ../../web/viewer/public/data]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import hall60_sim as hs
from export_web_flow import BLOCK, VMAX, downsample
from dct_sensors.precise import OpenFOAMRunner


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", type=Path, default=hs.ROOT / "usd" / "scenes" / "hall01.usda")
    ap.add_argument("--out", type=Path, default=hs.ROOT / "web" / "viewer" / "public" / "data")
    ap.add_argument("--cache", type=Path, default=hs.ROOT / "sim" / "out" / "jobs" / "flows")
    a = ap.parse_args()
    hs.DX = 0.10
    hall = hs.read_hall(a.scene)
    lay = hs.Layout(hall)
    cracs = [c["name"].lower() for c in hall["cracs"]]
    kw = {r["name"]: 10.0 for r in hall["racks"]}
    runner = OpenFOAMRunner(a.cache)
    present = lay.fluid | (lay.rack_id >= 0)
    fields, meta = [], []
    cases = [("all", None)] + [(f"off{i + 1:02d}", c) for i, c in enumerate(cracs)]
    for name, off in cases:
        fan = {c: (0.0 if c == off else 1.0) for c in cracs}
        npz, m = runner.flow(fan, kw, lambda f, note=None, name=name: print(f"  {name} {f * 100:5.1f}% {note or ''}", flush=True))
        z = np.load(npz)
        u = z["U"].astype(np.float64)
        sp = np.linalg.norm(u, axis=-1)
        d = downsample(u, present)
        fields.append(np.clip(np.round(d / VMAX * 127.0), -127, 127).astype(np.int8))
        meta.append({"name": name, "max_ms": round(float(sp.max()), 2), "openfoam": {"iterations": m.get("iterations"), "converged": m.get("converged")}})
        print(name, meta[-1], flush=True)
    shape = list(fields[0].shape[:3])
    blob = np.stack(fields).astype(np.int8)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "flow.bin").write_bytes(blob.tobytes())
    (a.out / "flow.json").write_text(json.dumps({
        "version": 1, "source": "openfoam",
        "note": "시각화 목적. OpenFOAM(k-epsilon, 부력, 다공질 랙, 10 cm, 정상 상태, 랙 10 kW 균일)의 흐름을 20 cm로 줄였다. 실측이 아니다.",
        "shape": shape, "cell_m": hs.DX * BLOCK, "vmax_ms": VMAX, "layout": "field,x,y,z,component int8 (scene axes, z up)",
        "fields": meta,
    }, indent=1, ensure_ascii=False), encoding="utf-8")
    print("저장:", a.out / "flow.bin", blob.nbytes)


if __name__ == "__main__":
    main()
