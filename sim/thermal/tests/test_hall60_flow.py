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
def lay():
    return hs.Layout(hs.read_hall(SCENE))


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


def test_single_crac_off_is_covered_by_the_other_crac_of_the_aisle(lay):
    _, bal = hs.source_field(lay, fans(lay, (1,)))  # CRAC_02, 통로 1은 CRAC_06이 남는다
    assert bal["aisle_leak_m3s"][1] == pytest.approx(9.6, abs=0.1)  # 통로 1의 배기 19.2 중 남은 CRAC 용량 9.6을 넘는 만큼 샌다
    _, bal2 = hs.source_field(lay, fans(lay, (0,)))  # CRAC_01, 통로 0은 CRAC_05가 남고 배기가 9.6이라 새지 않는다
    assert bal2["aisle_leak_m3s"][0] == pytest.approx(0.0, abs=1e-6)


def test_missing_leak_slots_stop_instead_of_dropping_flow(lay):
    broken = copy.copy(lay)
    broken.leak_sink = [np.zeros(lay.shape, dtype=bool) for _ in range(lay.n_aisles)]
    broken.leak_src = [np.zeros(lay.shape, dtype=bool) for _ in range(lay.n_aisles)]
    with pytest.raises(RuntimeError, match="지붕 틈"):
        hs.source_field(broken, fans(lay, (1, 5)))


def test_unbalanced_source_is_rejected(lay):
    s, _ = hs.source_field(lay, fans(lay))
    s = s.copy()
    s[lay.vent] += 5.0 / (lay.vent.sum() * hs.DX ** 3)  # 급기만 5 m3s 더 준다
    with pytest.raises(RuntimeError, match="원천의 합"):
        hs.solve_flow(lay, s)


def test_flow_converges_and_is_reasonable(lay):
    s, _ = hs.source_field(lay, fans(lay))
    u, info = hs.solve_flow(lay, s)
    assert info["cg_info"] == 0 and info["residual"] < 1e-4
    assert 1.0 < info["max_speed_ms"]
    # 방 안(바닥 위)은 8 m/s 아래. 이중 바닥 장면(docs/33 C단계 기본값)이면 공조기가 자기 바닥 면적으로 바닥 아래에 내려보내는 곳이
    # 가장 빠르다(최대 9.6 m3/s / 약 0.9 m2 = 약 10.7 m/s, OpenFOAM도 최고 12.4 m/s). 그곳은 그 송풍 속도의 1.2배 안쪽인지만 본다
    speed = np.linalg.norm(u, axis=-1)
    k = lay.floor_k[1] if lay.plenum else 0
    assert speed[:, :, k:][lay.fluid[:, :, k:]].max() < 8.0
    if lay.plenum:
        q, _ = hs.crac_returns(lay, fans(lay))  # 공조기별 유량(m3/s)
        area = min(((lay.dis_id == i).sum() for i in range(lay.n_cracs) if (lay.dis_id == i).any())) * hs.DX ** 2  # 바닥 송풍 면적(가장 작은 것)
        assert info["max_speed_ms"] < 1.2 * float(q.max()) / area
    assert np.isfinite(u).all()
    inside = lay.rack_id >= 0
    assert np.allclose(u[inside], lay.rack_dir[inside])  # 랙 안은 정해 둔 통과 속도
