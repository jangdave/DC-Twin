"""웹 보기용 공기 흐름(속도장) 내보내기. 시각화 목적이며 공학적 CFD가 아니다 (docs/22).

hall60_sim.py의 질량 보존 퍼텐셜 흐름을 그대로 쓴다. 정상 가동 1개와 CRAC 1대씩 멈춘 8개를 계산해
20 cm 격자로 줄이고 int8로 저장한다. 웹은 켜진 CRAC에 따라 이 장들을 겹쳐 쓴다(근사).

사용 (이 폴더에서):
    uv run --python 3.13 python export_web_flow.py [--out ../../web/viewer/public/data]
출력: flow.bin(int8, 장 순서대로), flow.json(격자, 배율, 장 목록)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import hall60_sim as hs

BLOCK = 2          # 10 cm -> 20 cm
VMAX = 4.0         # int8 배율: 127 = 4 m/s (더 빠른 값은 잘린다)


def downsample(u: np.ndarray, present: np.ndarray) -> np.ndarray:
    nx, ny, nz, _ = u.shape
    sx, sy, sz = nx // BLOCK, ny // BLOCK, nz // BLOCK
    u = u[: sx * BLOCK, : sy * BLOCK, : sz * BLOCK]
    w = present[: sx * BLOCK, : sy * BLOCK, : sz * BLOCK].astype(np.float32)
    ub = (u * w[..., None]).reshape(sx, BLOCK, sy, BLOCK, sz, BLOCK, 3).sum(axis=(1, 3, 5))
    wb = w.reshape(sx, BLOCK, sy, BLOCK, sz, BLOCK).sum(axis=(1, 3, 5))
    return np.divide(ub, wb[..., None], out=np.zeros_like(ub), where=wb[..., None] > 0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", type=Path, default=hs.ROOT / "usd" / "scenes" / "hall01.usda")
    ap.add_argument("--out", type=Path, default=hs.ROOT / "web" / "viewer" / "public" / "data")
    a = ap.parse_args()
    hall = hs.read_hall(a.scene)
    lay = hs.Layout(hall)
    n = lay.n_cracs
    present = lay.fluid | (lay.rack_id >= 0)
    fields, meta = [], []
    cases = [("all", np.ones(n))] + [(f"off{i + 1:02d}", np.where(np.arange(n) == i, 0.0, 1.0)) for i in range(n)]
    for name, fan in cases:
        s, info = hs.source_field(lay, fan)
        u, sol = hs.solve_flow(lay, s)
        d = downsample(u, present)
        q = np.clip(np.round(d / VMAX * 127.0), -127, 127).astype(np.int8)
        fields.append(q)
        meta.append({"name": name, "max_ms": sol["max_speed_ms"], "supply_m3s": info["supply_m3s"], "leak_m3s": info["aisle_leak_m3s"]})
        print(name, sol["max_speed_ms"], info["supply_m3s"], info["aisle_leak_m3s"])
    shape = list(fields[0].shape[:3])
    blob = np.stack(fields).astype(np.int8)  # (장, x, y, z, 3)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "flow.bin").write_bytes(blob.tobytes())
    (a.out / "flow.json").write_text(json.dumps({
        "version": 1, "note": "시각화 목적. 질량 보존 퍼텐셜 흐름(점성, 난류, 부력 없음). 실제 CFD 결과가 아니다.",
        "shape": shape, "cell_m": hs.DX * BLOCK, "vmax_ms": VMAX, "layout": "field,x,y,z,component int8 (scene axes, z up)",
        "fields": meta,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("저장:", a.out / "flow.bin", blob.nbytes // 1024, "KB", shape)


if __name__ == "__main__":
    main()
