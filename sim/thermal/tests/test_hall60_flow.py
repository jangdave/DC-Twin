"""hall60_sim.py의 공기 흐름 원천과 풀이 시험(GPU 없이 돈다). 실제 홀 장면(usd/scenes/hall01.usda)을 읽는다."""
from __future__ import annotations

import copy
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]  # 저장소
sys.path.insert(0, str(ROOT / "sim" / "thermal"))
from dct_thermal import hall60_sim as hs  # noqa: E402

SCENE = ROOT / "usd" / "scenes" / "hall01.usda"
pytestmark = pytest.mark.skipif(not SCENE.exists(), reason="hall01.usda 없음")


@pytest.fixture(scope="module")
def hall():
    return hs.read_hall(SCENE)


@pytest.fixture(scope="module")
def lay(hall):
    return hs.Layout(hall)


def fans(lay, off=()):
    f = np.ones(lay.n_cracs, dtype=np.float32)
    for i in off:
        f[i] = 0.0
    return f


@pytest.mark.parametrize("off", [(), (1,), (1, 5), tuple(range(8))], ids=["정상", "CRAC_02 정지", "같은 통로 2대 정지", "전부 정지"])
def test_sources_are_balanced(lay, off):
    s, bal = hs.source_field(lay, fans(lay, off))
    assert abs(s.sum()) / np.abs(s).sum() < 1e-9
    assert bal["rack_m3s"] == pytest.approx(57.6, abs=0.1)


def test_all_cracs_off_stops_supply_and_leaks_everything(lay):
    s, bal = hs.source_field(lay, fans(lay, range(8)))
    assert bal["supply_m3s"] == 0.0
    assert sum(bal["aisle_leak_m3s"]) == pytest.approx(57.6, abs=0.1)


def test_ceiling_plenum_shares_returns(lay):
    """천장 회수 방식(docs/35): 켜진 공조기가 홀 전체 배기(57.6 m3/s)를 똑같이 나눠 맡는다. 용량(9.6)을 넘을 때만 샌다."""
    assert lay.ceiling
    _, bal = hs.source_field(lay, fans(lay))
    assert bal["crac_return_m3s"] == pytest.approx([7.2] * 8, abs=0.01)
    _, bal = hs.source_field(lay, fans(lay, (1,)))  # 1대 정지: 7대가 8.23씩, 새지 않는다
    assert sum(bal["aisle_leak_m3s"]) == pytest.approx(0.0, abs=1e-6)
    assert max(bal["crac_return_m3s"]) == pytest.approx(57.6 / 7, abs=0.01)
    _, bal = hs.source_field(lay, fans(lay, (1, 5)))  # 2대 정지: 6대가 용량 9.6까지, 아직 새지 않는다
    assert sum(bal["aisle_leak_m3s"]) == pytest.approx(0.0, abs=1e-6)
    _, bal = hs.source_field(lay, fans(lay, (0, 1, 2)))  # 3대 정지: 5대 x 9.6 = 48, 9.6이 샌다
    assert sum(bal["aisle_leak_m3s"]) == pytest.approx(9.6, abs=0.05)
    f = fans(lay, (1,))
    f[0] = 0.5  # 팬을 줄인 공조기는 용량(4.8)까지만, 남는 양은 다른 공조기가 나눈다
    q, leak = hs.crac_returns(lay, f)
    assert q[0] == pytest.approx(4.8, abs=0.01) and q.sum() == pytest.approx(57.6, abs=0.01) and leak.sum() == pytest.approx(0.0, abs=1e-6)


def test_missing_leak_slots_stop_instead_of_dropping_flow(lay):
    broken = copy.copy(lay)
    broken.leak_sink = [np.zeros(lay.shape, dtype=bool) for _ in range(lay.n_aisles)]
    broken.leak_src = [np.zeros(lay.shape, dtype=bool) for _ in range(lay.n_aisles)]
    with pytest.raises(RuntimeError, match="지붕 틈"):
        hs.source_field(broken, fans(lay, (0, 1, 2)))


def test_unbalanced_source_is_rejected(lay):
    s, _ = hs.source_field(lay, fans(lay))
    s = s.copy()
    s[lay.vent] += 5.0 / (lay.vent.sum() * hs.DX ** 3)  # 급기만 5 m3s 더 준다
    with pytest.raises(RuntimeError, match="원천의 합"):
        hs.solve_flow(lay, s)


def test_flow_converges_and_is_reasonable(lay, hall):
    s, _ = hs.source_field(lay, fans(lay))
    u, info = hs.solve_flow(lay, s)
    assert info["cg_info"] == 0 and info["residual"] < 1e-4
    assert 1.0 < info["max_speed_ms"]
    # 방 안(바닥 위, 천장 회수 공간 포함)은 8 m/s 아래. 바닥 아래는 공조기가 자기 바닥 면적으로 내려보내는 곳이 가장 빠르므로
    # 그 송풍 속도(공조기 유량 / 바닥 면적)의 1.2배 안쪽인지 본다(OpenFOAM도 송풍구 근처가 가장 빠르다)
    speed = np.linalg.norm(u, axis=-1)
    k = lay.floor_k[1] if lay.plenum else 0
    room = lay.fluid.copy()
    room[:, :, :k] = False
    assert speed[room].max() < 8.0
    if lay.plenum:
        q, _ = hs.crac_returns(lay, fans(lay))  # 공조기별 유량(m3/s)
        area = min(((lay.dis_id == i).sum() for i in range(lay.n_cracs) if (lay.dis_id == i).any())) * hs.DX ** 2  # 바닥 송풍 면적(가장 작은 것)
        assert speed[:, :, :k][lay.fluid[:, :, :k]].max() < max(8.0, 1.2 * float(q.max()) / area)
    assert np.isfinite(u).all()
    inside = lay.rack_id >= 0
    assert np.allclose(u[inside], lay.rack_dir[inside])  # 랙 안은 정해 둔 통과 속도


def test_hot_air_rises_through_ceiling_grilles(lay, hall):
    """천장 회수 방식(docs/35): 열기 통로의 뜨거운 공기는 천장 회수 그릴(열기 통로 위, 줄 길이만큼)로 올라간다.
    그릴 면을 위로 지나는 유량이 랙 전체 유량(57.6 m3/s)의 95 % 이상이다(정상, 공조기 8대 가동)."""
    ceil = [p for p in hall["panels"] if p["name"].startswith("Ceiling_")]
    if not ceil:
        pytest.skip("천장 회수 방식이 아닌 장면")
    s, _ = hs.source_field(lay, fans(lay))
    u, _ = hs.solve_flow(lay, s)
    nx, ny, nz = lay.shape
    zc, _ = hs.rng(ceil[0]["min"][2], ceil[0]["max"][2], nz)  # 천장 판 칸 높이
    racks = hall["racks"]
    xs, _ = hs.rng(min(r["min"][0] for r in racks), min(r["max"][0] for r in racks), nx)
    _, xe = hs.rng(max(r["min"][0] for r in racks), max(r["max"][0] for r in racks), nx)
    up = 0.0
    for p in (p for p in hall["panels"] if p["name"].startswith("HotAisle_") and "_Door_W" in p["name"]):
        ys, ye = hs.rng(p["min"][1], p["max"][1], ny)
        w = u[xs:xe, ys:ye, zc, 2]
        up += float(w[lay.fluid[xs:xe, ys:ye, zc]].sum()) * hs.DX ** 2
    assert up > 0.95 * 57.6, up
