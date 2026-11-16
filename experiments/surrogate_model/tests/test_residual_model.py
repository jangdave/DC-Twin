"""잔차 모델의 순수 함수 시험(OpenFOAM 결과 파일 없이 돈다)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import residual_model as rm  # noqa: E402


def sample(fan_off=(), derate=None, remove=(), power=None):
    fan = {f"CRAC_{i + 1:02d}": 1.0 for i in range(8)}
    for i in fan_off:
        fan[f"CRAC_{i:02d}"] = 0.0
    for k, v in (derate or {}).items():
        fan[f"CRAC_{k:02d}"] = v
    return {"id": "x", "group": "g", "fan": fan, "row_power_kw": power or [10.0] * 6, "remove": list(remove)}


def test_mirror_patterns_share_a_key():
    # CRAC_02+06은 통로 1, CRAC_03+07은 통로 2: 거울상이다
    assert rm.pattern_key(sample(fan_off=(2, 6))) == rm.pattern_key(sample(fan_off=(3, 7)))
    # 통로 0과 통로 3도 거울상
    assert rm.pattern_key(sample(fan_off=(1, 5))) == rm.pattern_key(sample(fan_off=(4, 8)))


def test_different_patterns_have_different_keys():
    assert rm.pattern_key(sample(fan_off=(2, 6))) != rm.pattern_key(sample(fan_off=(1, 5)))
    assert rm.pattern_key(sample(fan_off=(2,))) != rm.pattern_key(sample(fan_off=(2, 6)))
    assert rm.pattern_key(sample(derate={2: 0.5})) != rm.pattern_key(sample(fan_off=(2,)))


def test_removed_samples_form_one_group():
    assert rm.pattern_key(sample(remove=["Rack_05"])) == rm.pattern_key(sample(fan_off=(3,), remove=["Rack_40", "Rack_41"])) == "remove"


@pytest.fixture(scope="module")
def geo():
    return rm.load_geometry()


def test_geometry_has_rows_and_aisles(geo):
    assert len(geo.names) == 60
    assert set(geo.row) == set(range(6))
    assert geo.n_hot == 4 and geo.n_cold == 3
    assert (geo.row_len == 10).all()
    assert (geo.pos_from_end[geo.row_len == 10] <= 4).all()
    assert int((geo.pos_from_end == 0).sum()) == 12  # 줄마다 양 끝 2기 x 6줄


def test_features_skip_removed_racks_and_match_names(geo):
    s = sample(fan_off=(2, 6), remove=["Rack_05", "Rack_06"])
    ours = {n: 20.0 for n in geo.names}
    info = {"aisle_leak_m3s": [0.0, 19.2, 0.0, 0.0], "supply_m3s": 38.4}
    X, o, names = rm.sample_features(geo, s, ours, info)
    assert len(names) == 58 and "Rack_05" not in names and "Rack_06" not in names
    assert X.shape == (58, len(rm.FEATURE_NAMES))
    assert np.allclose(X[:, 0], 20.0) and np.allclose(o, 20.0)
    assert np.isfinite(X).all()
    # 제거한 랙 근처 랙은 near_removed가 켜진다
    k = names.index("Rack_04")
    assert X[k, rm.FEATURE_NAMES.index("near_removed")] >= 1


def test_place_features(geo):
    """빈자리와 공조기 위치 특징(E9): 같은 줄 칸 수, 빈자리 뒤 열기 통로 가동, 꺼진 공조기 거리."""
    info = {"aisle_leak_m3s": [0.0, 19.2, 0.0, 0.0], "supply_m3s": 38.4}
    ours = {n: 20.0 for n in geo.names}
    F = rm.FEATURE_NAMES.index
    X, _, names = rm.sample_features(geo, sample(fan_off=(2, 6), remove=["Rack_05", "Rack_06"]), ours, info)
    assert X[names.index("Rack_04"), F("slots_to_removed")] == 1 and X[names.index("Rack_01"), F("slots_to_removed")] == 4
    assert X[names.index("Rack_15"), F("slots_to_removed")] == 10  # 다른 줄
    assert np.allclose(X[:, F("any_removed")], 1.0)
    # Rack_05·06의 열기 통로(0)는 CRAC_01·05가 맡고 둘 다 켜져 있다
    assert np.allclose(X[:, F("removed_aisle_fan")], 1.0)
    assert (X[:, F("dist_to_off_crac_m")] < rm.FAR_M).all() and (X[:, F("dist_to_on_crac_m")] < rm.FAR_M).all()
    # 아무것도 끄지 않고 빼지 않으면 먼 값으로 채운다
    X0, _, _ = rm.sample_features(geo, sample(), ours, info)
    assert np.allclose(X0[:, F("dist_to_off_crac_m")], rm.FAR_M) and np.allclose(X0[:, F("dist_to_removed_m")], rm.FAR_M)
    assert np.allclose(X0[:, F("slots_to_removed")], 10) and np.allclose(X0[:, F("any_removed")], 0.0)
    assert np.allclose(X0[:, F("removed_aisle_fan")], 1.0) and np.allclose(X0[:, F("hot_aisle_off_x_removed")], 0.0)
    # CRAC_01이 꺼지면 그 공조기에 가까운 랙일수록 거리가 짧다
    X1, _, n1 = rm.sample_features(geo, sample(fan_off=(1,)), ours, info)
    assert X1[n1.index("Rack_01"), F("dist_to_off_crac_m")] < X1[n1.index("Rack_60"), F("dist_to_off_crac_m")]


def test_leave_group_out_never_trains_on_the_held_group():
    rng = np.random.default_rng(0)
    data = []
    for g in ("a", "b", "c"):
        for i in range(3):
            X = rng.normal(size=(10, 4))
            data.append({"id": f"{g}{i}", "group": g, "pattern": g, "X": X, "ours": X[:, 0] + 20.0, "of": X[:, 0] + 20.0 + 1.0})
    res = rm.leave_group_out(data, "group")
    # 모든 샘플의 목표가 우리 값 + 1.0이므로 편향 보정은 완벽하게 맞힌다(다른 묶음으로 학습해도)
    assert np.allclose(res["평균 편향 보정"], 0.0, atol=1e-9)
    assert np.allclose(res["우리 솔버 그대로"], 1.0)


def test_rmse():
    assert rm.rmse([1, 2, 3], [1, 2, 3]) == 0.0
    assert rm.rmse([0, 0], [3, 4]) == pytest.approx(np.sqrt(12.5))
