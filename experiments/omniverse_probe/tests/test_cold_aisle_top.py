"""냉기 통로 윗면 통과 쉬움(SIGMA_COLD_TOP) 시험: 윗면으로 들어오는 공기가 줄고 양끝으로 더 들어오는지, 흐름이 여전히 수렴하고 질량이 보존되는지.

배경: 퍼텐셜 흐름은 냉기 통로의 윗면과 양끝을 구분하지 못해 윗면으로 너무 많이 들어온다(OpenFOAM 기준 답은 양끝이 더 많음).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import hall60_sim as hs  # noqa: E402

SCENE = HERE.parents[1] / "usd" / "scenes" / "hall01.usda"
pytestmark = pytest.mark.skipif(not SCENE.exists(), reason="hall01.usda 없음")


def inflows(sigma):
    old = hs.SIGMA_COLD_TOP
    hs.SIGMA_COLD_TOP = sigma
    try:
        hall = hs.read_hall(SCENE)
        lay = hs.Layout(hall)
        fan = np.ones(lay.n_cracs, dtype=np.float32)
        fan[1] = 0.0  # CRAC_02 한 대 정지
        s, bal = hs.source_field(lay, fan)
        u, info = hs.solve_flow(lay, s)
    finally:
        hs.SIGMA_COLD_TOP = old
    cy = sorted({round((v["min"][1] + v["max"][1]) / 2 / 10.0) * 10.0 for v in hall["vents"]})
    xa, xb = min(r["min"][0] for r in hall["racks"]), max(r["max"][0] for r in hall["racks"])
    ztop = max(r["max"][2] for r in hall["racks"])
    kz = int(np.floor(ztop / 100.0 / hs.DX + 1e-6))
    i0, i1 = hs.rng(xa, xb, lay.shape[0])
    top = ends = 0.0
    for y in cy:
        j0, j1 = hs.rng(y - 60.0, y + 60.0, lay.shape[1])
        top += float((-u[i0:i1, j0:j1, kz + 1, 2]).sum()) * hs.DX ** 2  # 아래로 들어오는 순 유량(부호 포함)
        left = u[i0 - 1, j0:j1, :kz, 0]
        right = -u[i1, j0:j1, :kz, 0]
        ends += float(left.sum() + right.sum()) * hs.DX ** 2  # 양끝으로 들어오는 순 유량(부호 포함)
    return top, ends, info, s.sum()


def test_screen_shifts_inflow_from_top_to_ends():
    top1, ends1, _, _ = inflows(1.0)
    top2, ends2, info, total = inflows(0.1)
    assert top2 < 0.95 * top1, f"윗면 유입이 충분히 줄지 않았다: {top1:.2f} -> {top2:.2f}"
    assert ends2 > ends1, f"양끝 유입이 늘지 않았다: {ends1:.2f} -> {ends2:.2f}"
    assert info["cg_info"] == 0 and info["residual"] < 1e-4  # 여전히 수렴
    assert abs(total) < 1e-9  # 원천의 합은 0(질량 보존)


def test_sigma_one_is_the_plain_potential_flow():
    """sigma 1이면 모든 칸의 통과 쉬움이 1이다(예전 풀이와 같다)."""
    old = hs.SIGMA_COLD_TOP
    hs.SIGMA_COLD_TOP = 1.0
    try:
        lay = hs.Layout(hs.read_hall(SCENE))
    finally:
        hs.SIGMA_COLD_TOP = old
    assert np.all(lay.sigma == 1.0)
