"""열 보존 이류(fv, V4, docs/32): 온도가 고르고 들어오는 공기도 같은 온도면 아무것도 바뀌지 않아야 하고,
랙 발열은 랙 뒷면 공기의 온도 상승으로 정확히 들어와야 한다. CPU에서 몇 단계만 돈다."""
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


@pytest.fixture(scope="module")
def hall_lay():
    hs.DX = 0.10
    hall = hs.read_hall(SCENE)
    return hall, hs.Layout(hall)


@pytest.mark.parametrize("failed", [[], [1, 5]])
def test_uniform_field_stays_uniform(hall_lay, failed):
    hall, lay = hall_lay
    sim = hs.Sim(hall, lay, 0.0, 10.0, device="cpu", advection="fv")  # 발열 0
    sim.T.fill_(sim.t_supply)  # 공기 전체를 급기 온도로
    fan = np.ones(lay.n_cracs, dtype=np.float32)
    fan[failed] = 0.0
    sim.set_fans(fan)
    for _ in range(5):
        sim.step()
    T = sim.T.numpy()[lay.fluid]
    assert np.abs(T - sim.t_supply).max() < 1e-3


def test_rack_heat_enters_exactly(hall_lay):
    """한 단계 동안 공기 전체 열의 변화 = 랙 발열 + 급기로 들어온 열 - 빨려 나간 열. 급기 = 초기 온도로 두면 첫 단계는 랙 발열만 남는다."""
    hall, lay = hall_lay
    sim = hs.Sim(hall, lay, 10.0, 10.0, device="cpu", advection="fv")
    sim.set_fans(np.ones(lay.n_cracs, dtype=np.float32))
    sim.T.fill_(sim.t_supply)  # 공기 전체가 급기 온도면 급기와 빨려 나가는 공기의 열은 같다
    e0 = float(sim.T.numpy()[lay.fluid].astype(np.float64).sum())
    sim.step()
    e1 = float(sim.T.numpy()[lay.fluid].astype(np.float64).sum())
    kw = (e1 - e0) * hs.RHO_CP * hs.DX ** 3 / sim.dt
    assert kw == pytest.approx(10.0 * len(hall["racks"]), rel=0.01)
