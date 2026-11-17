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


def _sim(hall, lay, off):
    sim = hs.Sim(hall, lay, 10.0, 1.0, device="cpu")
    fan = np.ones(lay.n_cracs, dtype=np.float32)
    fan[list(off)] = 0.0
    sim.set_fans(fan)
    return sim


@pytest.fixture(scope="module")
def case():
    """새는 경우와 새지 않는 경우. 옛 장면: 같은 통로(통로 1)의 CRAC 2대(2, 6번) 정지면 통로 1이 샌다.
    천장 회수 장면(docs/35): 공통 회수 공간이라 3대(1~3번) 정지부터 새고, 새는 길은 하나(0번 자리)다."""
    hall = hs.read_hall(SCENE)
    lay = hs.Layout(hall)
    if lay.ceiling:
        leak, a = (0, 1, 2), 0
        quiet_sim, qa = _sim(hall, lay, (1,)), 0  # 1대 정지: 새는 길(0번)이 있어도 새지 않는다
    else:
        leak, a = (1, 5), 1
        quiet_sim, qa = None, 0  # 같은 계산에서 새지 않는 통로 0
    sim = _sim(hall, lay, leak)
    return {"sim": sim, "lay": lay, "a": a, "quiet": quiet_sim or sim, "qa": qa}


def test_leaking_aisle_is_marked(case):
    on = case["sim"].leak_on.numpy()
    assert on[case["a"]] == 1.0
    assert all(on[i] == 0.0 for i in range(len(on)) if i != case["a"])


def test_leaked_air_keeps_its_temperature(case):
    sim, lay, a = case["sim"], case["lay"], case["a"]
    T = np.full(lay.shape, 20.0, dtype=np.float32)
    T[lay.leak_sink[a]] = 40.0  # 새는 길의 빨려 들어가는 칸만 뜨겁다
    sim.T = wp.array(T, dtype=float, device="cpu")
    sim.step()
    out = sim.T.numpy()
    assert out[lay.leak_src[a]] == pytest.approx(40.0, abs=1e-4)  # 나오는 칸은 빨려 들어간 칸의 평균 온도


def test_aisles_without_leak_are_not_touched(case):
    sim, lay, qa = case["quiet"], case["lay"], case["qa"]
    T = np.full(lay.shape, 20.0, dtype=np.float32)
    T[lay.leak_sink[qa]] = 40.0  # 새지 않는 길의 빨려 들어가는 칸이 뜨거워도
    sim.T = wp.array(T, dtype=float, device="cpu")
    sim.step()
    out = sim.T.numpy()
    assert out[lay.leak_src[qa]].max() < 25.0  # 나오는 칸의 온도를 강제로 올리지 않는다
