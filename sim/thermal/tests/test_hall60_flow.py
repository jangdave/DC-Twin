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


def hot_enclosure(lay, hall) -> np.ndarray:
    """줄 끝 문 + 머리 위 덕트 장면(docs/35)의 열기 통로와 덕트 안 칸. 통로마다 y는 지붕 폭, 줄 사이(문과 문 사이)는 바닥부터,
    그 밖(줄 끝 ~ 벽)은 덕트 바닥판 위만. 덕트가 없는 장면이면 빈 배열."""
    enc = np.zeros(lay.shape, dtype=bool)
    nx, ny, nz = lay.shape
    for roof in (p for p in hall["panels"] if p["name"].startswith("HotAisle_") and p["name"].endswith("_Roof")):
        pre = roof["name"][: -len("_Roof")]
        floors = [p for p in hall["panels"] if p["name"].startswith(pre + "_DuctFloor_")]
        doors = [p for p in hall["panels"] if p["name"].startswith(pre + "_Door_")]
        if not floors or not doors:
            continue
        ys, ye = hs.rng(roof["min"][1], roof["max"][1], ny)
        _, zf = hs.rng(floors[0]["min"][2], floors[0]["max"][2], nz)
        x0, _ = hs.rng(min(p["min"][0] for p in doors), min(p["max"][0] for p in doors), nx)
        _, x1 = hs.rng(max(p["min"][0] for p in doors), max(p["max"][0] for p in doors), nx)
        enc[:, ys:ye, zf:] = True
        enc[x0:x1, ys:ye, :] = True
    return enc & lay.fluid


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


def test_flow_converges_and_is_reasonable(lay, hall):
    s, _ = hs.source_field(lay, fans(lay))
    u, info = hs.solve_flow(lay, s)
    assert info["cg_info"] == 0 and info["residual"] < 1e-4
    assert 1.0 < info["max_speed_ms"]
    # 방 안(바닥 위)은 8 m/s 아래. 이중 바닥 장면(docs/33 C단계 기본값)이면 공조기가 자기 바닥 면적으로 바닥 아래에 내려보내는 곳이
    # 가장 빠르다(최대 9.6 m3/s / 약 0.9 m2 = 약 10.7 m/s, OpenFOAM도 최고 12.4 m/s). 그곳은 그 송풍 속도의 1.2배 안쪽인지만 본다
    # 줄 끝 문 + 머리 위 덕트 장면(docs/35)이면 열기 통로와 덕트 안(사람이 없는 곳)은 바닥 송풍구와 같은 기준으로 보고,
    # 그 밖의 방(덕트 아래 통로 포함)만 8 m/s 아래인지 본다. 덕트 바닥판 끝 모서리를 도는 곳이 퍼텐셜 흐름에서 가장 빠르다(약 10 m/s).
    # 대신 덕트 단면 평균 풍속을 따로 본다(test_duct_mean_speed).
    speed = np.linalg.norm(u, axis=-1)
    k = lay.floor_k[1] if lay.plenum else 0
    room = lay.fluid.copy()
    room[:, :, :k] = False
    enc = hot_enclosure(lay, hall)
    assert speed[room & ~enc].max() < 8.0
    if lay.plenum:
        q, _ = hs.crac_returns(lay, fans(lay))  # 공조기별 유량(m3/s)
        area = min(((lay.dis_id == i).sum() for i in range(lay.n_cracs) if (lay.dis_id == i).any())) * hs.DX ** 2  # 바닥 송풍 면적(가장 작은 것)
        assert info["max_speed_ms"] < 1.2 * float(q.max()) / area
    elif enc.any():
        raise AssertionError("덕트 장면은 이중 바닥 기준(바닥 송풍 면적)으로 격벽 안을 본다")
    assert np.isfinite(u).all()
    inside = lay.rack_id >= 0
    assert np.allclose(u[inside], lay.rack_dir[inside])  # 랙 안은 정해 둔 통과 속도


def test_duct_mean_speed(lay, hall):
    """머리 위 덕트(docs/35): 줄 끝 ~ 공조기 사이 덕트 단면의 평균 풍속이 6 m/s 아래(정상, 공조기 8대 가동).
    덕트가 좁으면 처음 설계(높이 2.0 ~ 2.8 m, 지붕 입구 60 cm)처럼 20 m/s까지 오른다."""
    floors = [p for p in hall["panels"] if "_DuctFloor_" in p["name"]]
    if not floors:
        pytest.skip("덕트가 없는 장면")
    s, _ = hs.source_field(lay, fans(lay))
    u, _ = hs.solve_flow(lay, s)
    nx, ny, nz = lay.shape
    for p in floors:
        xs, xe = hs.rng(p["min"][0], p["max"][0], nx)
        ys, ye = hs.rng(p["min"][1], p["max"][1], ny)
        _, zf = hs.rng(p["min"][2], p["max"][2], nz)
        xm = (xs + xe) // 2  # 덕트 가운데 단면(x 고정)
        cut = lay.fluid[xm, ys:ye, zf:]
        q = np.abs(u[xm, ys:ye, zf:, 0][cut]).sum() * hs.DX ** 2  # 단면을 지나는 유량(m3/s)
        area = cut.sum() * hs.DX ** 2
        assert q > 1.0, p["name"]  # 덕트로 실제로 공기가 지나간다
        assert q / area < 6.0, (p["name"], q / area)
