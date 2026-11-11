"""랙 배치를 바꿔 다시 계산하는 흐름 시험: 장면 편집(layout_whatif.apply_edits)과, 배치를 바꿔도 먼 곳의 원천이 변하지 않는지(국소성)."""
from __future__ import annotations

import copy
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import hall60_sim as hs  # noqa: E402
import layout_whatif as lw  # noqa: E402

SCENE = HERE.parents[1] / "usd" / "scenes" / "hall01.usda"
pytestmark = pytest.mark.skipif(not SCENE.exists(), reason="hall01.usda 없음")


@pytest.fixture(scope="module")
def hall():
    return hs.read_hall(SCENE)


def fans_all(lay):
    return np.ones(lay.n_cracs, dtype=np.float32)


def test_move_shifts_only_that_rack(tmp_path):
    out = tmp_path / "edit.usda"
    info = lw.apply_edits(SCENE, out, {"move": {"Rack_15": [0, 10, 0]}})  # 통로 쪽으로 10 cm(옆 장비와 겹치지 않는 거리)
    assert info["moved"] == 1 and info["removed"] == 0
    a, b = hs.read_hall(SCENE), hs.read_hall(out)
    ra = {r["name"]: r for r in a["racks"]}
    rb = {r["name"]: r for r in b["racks"]}
    assert len(rb) == len(ra) == 60
    assert rb["Rack_15"]["min"][1] == pytest.approx(ra["Rack_15"]["min"][1] + 10, abs=1e-3)
    assert rb["Rack_15"]["min"][0] == pytest.approx(ra["Rack_15"]["min"][0], abs=1e-3)
    for n in ra:
        if n != "Rack_15":
            assert rb[n]["min"] == pytest.approx(ra[n]["min"], abs=1e-3)


def test_remove_drops_rack_and_its_sensors(tmp_path):
    out = tmp_path / "edit.usda"
    lw.apply_edits(SCENE, out, {"remove": ["Rack_05"]})
    b = hs.read_hall(out)
    assert len(b["racks"]) == 59 and "Rack_05" not in {r["name"] for r in b["racks"]}
    assert not any(a["equipment"] == "Rack_05" for a in b["anchors"])
    assert len(b["cracs"]) == 8  # 다른 장비는 그대로


def test_moving_a_rack_onto_another_is_rejected(tmp_path):
    out = tmp_path / "edit.usda"
    with pytest.raises(ValueError, match="겹친다"):
        lw.apply_edits(SCENE, out, {"move": {"Rack_15": [60, 0, 0]}})  # 바로 옆 랙(Rack_16) 자리
    assert not out.exists()


def test_moving_a_rack_to_free_space_is_accepted(tmp_path):
    # 줄의 끝 랙을 줄 바깥쪽 여유 공간(끝 여유 150 cm)으로 60 cm 옮긴다. 어느 쪽이 비었는지는 장면에서 찾는다.
    hall = hs.read_hall(SCENE)
    lw_ok = None
    for sign in (60, -60):
        try:
            lw_ok = lw.apply_edits(SCENE, tmp_path / f"edit{sign}.usda", {"move": {"Rack_20": [sign, 0, 0]}})
            break
        except ValueError:
            continue
    assert lw_ok is not None and lw_ok["moved"] == 1
    assert len(hall["racks"]) == 60


def test_original_scene_is_not_modified(tmp_path):
    before = SCENE.read_bytes()
    lw.apply_edits(SCENE, tmp_path / "edit.usda", {"remove": ["Rack_05"]})
    assert SCENE.read_bytes() == before


@pytest.mark.parametrize("edits, error", [
    ({"remove": ["Rack_99"]}, KeyError),
    ({"move": {"Rack_99": [0, 0, 0]}}, KeyError),
    ({"move": {"Rack_05": [0, 0]}}, ValueError),
    ({"move": {"Rack_05": [0, 0, 0]}, "remove": ["Rack_05"]}, ValueError),
])
def test_bad_edits_are_rejected(tmp_path, edits, error):
    with pytest.raises(error):
        lw.apply_edits(SCENE, tmp_path / "edit.usda", edits)


def test_removing_a_rack_does_not_change_sources_of_other_cold_aisles(hall):
    """랙 하나를 빼도 다른 냉기 통로의 급기, 다른 랙의 흡입, 배기 원천은 그대로여야 한다(예전에는 홀 전체가 똑같이 나눠 가져 먼 곳도 바뀌었다)."""
    lay = hs.Layout(hall)
    s0, _ = hs.source_field(lay, fans_all(lay))
    names = [r["name"] for r in hall["racks"]]
    gone = names.index("Rack_55")
    hall2 = copy.deepcopy(hall)
    del hall2["racks"][gone]
    lay2 = hs.Layout(hall2)
    s1, bal = hs.source_field(lay2, fans_all(lay2))
    assert abs(s1.sum()) / np.abs(s1).sum() < 1e-9  # 질량 보존은 그대로
    assert bal["rack_m3s"] == pytest.approx(56.64, abs=0.1)
    cold_gone = lay.rack_cold[gone]
    # 다른 냉기 통로의 급기구 칸은 같다
    for c in range(lay.n_cold):
        if c == cold_gone:
            continue
        cells = (lay.vent_id >= 0) & (np.array(lay.vent_cold)[np.maximum(lay.vent_id, 0)] == c)
        # 제거한 랙의 통로가 아닌 통로에서도 CRAC 회수 합이 줄면 급기가 비례해 줄 수 있다. 다만 그 변화는 작아야 한다.
        assert np.allclose(s1[cells], s0[cells], rtol=0.03), f"냉기 통로 {c}의 급기가 크게 달라졌다"
    # 다른 랙의 흡입, 배기 원천은 그대로
    for i, n in enumerate(names):
        if i == gone:
            continue
        j = i - (1 if i > gone else 0)
        m0 = lay.intake_id == i
        m1 = lay2.intake_id == j
        assert m0.sum() == m1.sum()
        assert np.allclose(s1[m1], s0[m0])
