"""급기 온도를 바꾸면 Warp 열 계산의 온도장이 같은 폭으로 옮겨 간다(식이 온도에 대해 선형). 기본값(18도)에서는 결과가 달라지지 않는다.

    cd experiments/omniverse_probe && uv run --python 3.13 python -m pytest tests/test_supply_shift.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
wp = pytest.importorskip("warp")
import hall60_sim as hs  # noqa: E402

SCENE = Path(__file__).resolve().parents[3] / "usd" / "scenes" / "hall01.usda"


def run(t_supply, steps=60):
    hall = hs.read_hall(SCENE)
    lay = hs.Layout(hall)
    sim = hs.Sim(hall, lay, 10.0, 10.0, t_supply=t_supply) if t_supply is not None else hs.Sim(hall, lay, 10.0, 10.0)
    sim.set_fans(np.ones(len(hall["cracs"]), dtype=np.float32))
    for _ in range(steps):
        sim.step()
    return sim.T.numpy(), lay


def test_default_equals_explicit_18():
    a, _ = run(None)
    b, _ = run(18.0)
    assert np.array_equal(a, b)


def test_field_shifts_by_the_supply_difference():
    base, lay = run(18.0)
    hot, _ = run(24.0)
    air = ~lay.solid
    d = (hot - base)[air]
    assert abs(float(d.mean()) - 6.0) < 0.02
    assert float(np.abs(d - 6.0).max()) < 0.2   # 부동소수점 오차와 이류 보정의 값 제한 정도
