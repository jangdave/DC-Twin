"""정확한 계산 작업의 OpenFOAM 흐름을 웹 공기 흐름 형식으로 바꾼다(docs/31 7장, 2026-11-16).

웹의 미리 계산한 흐름(`web/viewer/public/data/flow.bin`, experiments/omniverse_probe/export_web_flow_of.py)과 같은 격자
(10 cm를 20 cm로 줄임, 장면 축, z가 위)와 int8 눈금을 쓴다. 다른 점은 encoding이 "sequence"라는 것이다:
장마다 그 작업의 팬 상태 하나의 흐름 값이고(차이가 아님), 웹은 지금 재생 중인 팬 값과 가장 가까운 장을 고른다.
시각화 목적이며 실측이 아니다.
"""
from __future__ import annotations

import base64

import numpy as np

BLOCK = 2  # 10 cm -> 20 cm
VMAX = 8.0  # int8 배율: 127 = 8 m/s(웹 flow.json과 같은 눈금 범위, 더 빠른 값은 잘린다)


def downsample(u: np.ndarray, present: np.ndarray, block: int = BLOCK) -> np.ndarray:
    """block^3 칸을 하나로 평균한다. 막힌 칸(present False)은 빼고 평균한다(export_web_flow.downsample과 같은 식)."""
    nx, ny, nz, _ = u.shape
    sx, sy, sz = nx // block, ny // block, nz // block
    u = u[: sx * block, : sy * block, : sz * block]
    w = present[: sx * block, : sy * block, : sz * block].astype(np.float32)
    ub = (u * w[..., None]).reshape(sx, block, sy, block, sz, block, 3).sum(axis=(1, 3, 5))
    wb = w.reshape(sx, block, sy, block, sz, block).sum(axis=(1, 3, 5))
    return np.divide(ub, wb[..., None], out=np.zeros_like(ub), where=wb[..., None] > 0)


def encode(fields: list[dict], present: np.ndarray, dx_m: float, z0_m: float = 0.0, plenum: dict | None = None) -> dict:
    """fields: [{"U": (nx, ny, nz, 3) m/s, "fan": {crac_01: 0~1}, "from_s": 초, "iterations": n, "converged": bool}]
    돌려주는 값: 웹이 읽는 흐름 정보(JSON으로 보낼 수 있다). 값은 data_b64(int8, field,x,y,z,component 순서)에 있다."""
    if not fields:
        raise ValueError("흐름이 없다")
    blobs, meta, shape = [], [], None
    for f in fields:
        u = np.asarray(f["U"], dtype=np.float64)
        d = downsample(u, present)
        shape = shape or list(d.shape[:3])
        if list(d.shape[:3]) != shape:
            raise ValueError("흐름장 격자 크기가 서로 다르다")
        blobs.append(np.clip(np.round(d / VMAX * 127.0), -127, 127).astype(np.int8))
        meta.append({"name": f"t{int(f.get('from_s', 0))}", "from_s": f.get("from_s", 0), "fan": f["fan"],
                     "max_ms": round(float(np.linalg.norm(u, axis=-1).max()), 2),
                     "openfoam": {"iterations": f.get("iterations"), "converged": f.get("converged")}})
    data = np.stack(blobs)
    return {
        "version": 1, "source": "openfoam", "encoding": "sequence",
        "note": "시각화 목적. 이 작업의 OpenFOAM 정상 상태 흐름(팬 상태마다 하나)을 20 cm로 줄였다. 실측이 아니다.",
        "shape": shape, "cell_m": dx_m * BLOCK, "vmax_ms": VMAX, "z0_m": z0_m, "plenum": plenum,
        "layout": "field,x,y,z,component int8 (scene axes, z up). encoding sequence: 장마다 그 팬 상태의 값",
        "fields": meta,
        "data_b64": base64.b64encode(data.tobytes()).decode("ascii"),
    }
