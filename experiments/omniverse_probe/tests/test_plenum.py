"""이중 바닥과 바닥 아래 공간(docs/33): 공조기가 바닥 아래로 불어 넣고 천공 타일로 올라오는지, 질량과 열이 맞는지. CPU에서 몇 단계만."""
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
PLENUM = {"depth_cm": 60.0, "floor_cm": 20.0, "open_ratio": 0.25}


@pytest.fixture(scope="module")
def hall_lay():
    hs.DX = 0.10
    hall = hs.read_hall(SCENE)
    assert hall["plenum"] is None  # 기본 장면은 이중 바닥을 끈다(보정 모델을 다시 만들기 전까지)
    hall = {**hall, "plenum": PLENUM}  # 장면 속성(dct:plenumDepthCm 등)을 읽은 것과 같은 모양
    return hall, hs.Layout(hall)


def test_grid_grows_down_and_floor_opens_only_at_tiles(hall_lay):
    hall, lay = hall_lay
    base = hs.Layout({**hall, "plenum": None})
    assert lay.shape[2] == base.shape[2] + 8  # 60 + 20 cm = 8칸
    kd0, kf1 = lay.floor_k
    assert (kd0, kf1) == (6, 8)
    assert lay.fluid[:, :, :kd0].all()  # 바닥 아래 공간은 모두 공기
    floor = lay.fluid[:, :, kd0:kf1]
    assert floor.sum() == lay.tile.sum() > 0  # 바닥판은 타일 자리만 열림
    assert (lay.dis_id >= 0).sum() > 0 and not lay.vent[:, :, kf1:].any()  # 찬 공기는 바닥 아래에서만 들어온다


def test_flow_through_tiles_balances_supply(hall_lay):
    hall, lay = hall_lay
    fan = np.ones(lay.n_cracs)
    fan[1] = 0.0
    s, info = hs.source_field(lay, fan)
    faces: dict = {}
    hs.solve_flow(lay, s, faces)
    kf1 = lay.floor_k[1]
    up = float((faces[2][:, :, kf1] * lay.tile[:, :, kf1 - 1]).sum() * hs.DX ** 2)
    assert up == pytest.approx(info["supply_m3s"], rel=0.01)  # 타일로 올라온 양 = 공조기가 불어 넣은 양


def test_fv_heat_enters_exactly_with_plenum(hall_lay):
    hall, lay = hall_lay
    sim = hs.Sim(hall, lay, 10.0, 10.0, device="cpu", advection="fv")
    sim.set_fans(np.ones(lay.n_cracs, dtype=np.float32))
    sim.T.fill_(sim.t_supply)
    e0 = float(sim.T.numpy()[lay.fluid].astype(np.float64).sum())
    sim.step()
    e1 = float(sim.T.numpy()[lay.fluid].astype(np.float64).sum())
    assert (e1 - e0) * hs.RHO_CP * hs.DX ** 3 / sim.dt == pytest.approx(600.0, rel=0.01)
