"""새는 공기(격벽 지붕 틈)가 열을 그대로 가지고 나오는지 시험한다. CPU에서 한 단계만 돈다.

예전에는 지붕 틈 아래에서 빨려 들어간 뜨거운 공기가 위에서 나올 때 주변 온도로 바뀌어 열이 사라졌다
(통로 1에서 30.2도가 24.0도로, OpenFOAM 기준 답에서는 31.13도가 31.15도로 보존됨).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import warp as wp

ROOT = Path(__file__).resolve().parents[3]  # 저장소
sys.path.insert(0, str(ROOT / "sim" / "thermal"))
from dct_thermal import hall60_sim as hs  # noqa: E402

SCENE = ROOT / "usd" / "scenes" / "hall01.usda"
pytestmark = pytest.mark.skipif(not SCENE.exists(), reason="hall01.usda 없음")


@pytest.fixture(scope="module")
def sim_and_layout():
    hall = hs.read_hall(SCENE)
    lay = hs.Layout(hall)
    sim = hs.Sim(hall, lay, 10.0, 1.0, device="cpu")
    fan = np.ones(lay.n_cracs, dtype=np.float32)
    fan[1] = 0.0
    fan[5] = 0.0  # 같은 통로(통로 1)의 CRAC 2대 정지: 이 통로가 새기 시작한다
    sim.set_fans(fan)
    return sim, lay


def test_leaking_aisle_is_marked(sim_and_layout):
    sim, lay = sim_and_layout
    on = sim.leak_on.numpy()
    assert on[1] == 1.0
    assert on[0] == 0.0 and on[2] == 0.0 and on[3] == 0.0


def test_leaked_air_keeps_its_temperature(sim_and_layout):
    sim, lay = sim_and_layout
    T = np.full(lay.shape, 20.0, dtype=np.float32)
    T[lay.leak_sink[1]] = 40.0  # 통로 1의 지붕 틈 아래만 뜨겁다
    sim.T = wp.array(T, dtype=float, device="cpu")
    sim.step()
    out = sim.T.numpy()
    assert out[lay.leak_src[1]] == pytest.approx(40.0, abs=1e-4)  # 위로 나오는 칸은 빨려 들어간 칸의 평균 온도


def test_aisles_without_leak_are_not_touched(sim_and_layout):
    sim, lay = sim_and_layout
    T = np.full(lay.shape, 20.0, dtype=np.float32)
    T[lay.leak_sink[0]] = 40.0  # 새지 않는 통로 0의 틈 아래가 뜨거워도
    sim.T = wp.array(T, dtype=float, device="cpu")
    sim.step()
    out = sim.T.numpy()
    assert out[lay.leak_src[0]].max() < 25.0  # 위쪽 칸의 온도를 강제로 올리지 않는다
