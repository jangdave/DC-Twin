"""예측기(불확실성, 신뢰 등급, 범위 밖 되돌림) 시험. 저장소에 있는 OpenFOAM 학습 결과를 읽는다."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import predictor as pr  # noqa: E402
import residual_model as rm  # noqa: E402

SAMPLES = rm.BASE / "surrogate" / "samples.json"
pytestmark = pytest.mark.skipif(not (rm.DATA / "ours_progress.json").exists(), reason="학습 결과 없음")


@pytest.fixture(scope="module")
def env():
    specs = {s["id"]: s for s in json.loads(SAMPLES.read_text(encoding="utf-8"))["samples"]}
    info = json.loads((rm.DATA / "ours_progress.json").read_text(encoding="utf-8"))
    data = [d for d in rm.load_dataset(rm.DATA, SAMPLES, only_converged=True) if not d["holdout"]]
    p = pr.ResidualPredictor(n_estimators=60).fit(data, specs)
    d0 = data[0]
    return {"p": p, "specs": specs, "info": info, "data": data, "d0": d0, "ours0": dict(zip(d0["names"], d0["ours"]))}


def test_normal_input_is_corrected_with_ordered_interval(env):
    d0 = env["d0"]
    r = env["p"].predict(env["specs"][d0["id"]], env["ours0"], env["info"][d0["id"]])
    assert not r.fallback and r.reason == ""
    assert set(r.corrected) == set(d0["names"])
    for n in r.corrected:
        assert r.lower90[n] <= r.corrected[n] <= r.upper90[n]
        assert r.upper90[n] - r.lower90[n] >= 2 * pr.INTERVAL_FLOOR - 1e-9  # 구간 반폭 바닥
        assert r.level[n] in ("ok", "caution", "low")
        assert r.sigma[n] >= 0
    assert np.isfinite(r.novelty)


@pytest.mark.parametrize("edit, why", [
    (lambda s: s.update(row_power_kw=[20.0] + s["row_power_kw"][1:]), "전력"),
    (lambda s: s["fan"].update(CRAC_01=1.5), "팬"),
    (lambda s: s.update(remove=["Rack_01", "Rack_02", "Rack_03", "Rack_04", "Rack_05"]), "제거한 랙"),
    (lambda s: s.update(remove=["Rack_99"]), "없는 랙"),
    # 줄 평균은 범위 안이지만 랙 하나가 범위 밖(docs/30 H3): 랙별 전력을 주면 잡는다
    (lambda s: s.update(rack_power_kw={"Rack_01": 30.0, "Rack_02": 8.0}), "랙 전력"),
])
def test_out_of_range_input_falls_back_to_ours(env, edit, why):
    d0 = env["d0"]
    s = copy.deepcopy(env["specs"][d0["id"]])
    edit(s)
    r = env["p"].predict(s, env["ours0"], env["info"][d0["id"]])
    assert r.fallback and why in r.reason
    assert all(r.corrected[n] == env["ours0"][n] for n in r.corrected)  # 우리 솔버 값 그대로
    assert all(v == "fallback" for v in r.level.values())
    assert all(np.isnan(v) for v in r.sigma.values())


def test_rack_power_inside_range_is_corrected(env):
    """랙별 전력이 모두 학습 범위 안이면 그대로 보정한다(랙별 전력은 범위 검사에만 쓴다)."""
    d0 = env["d0"]
    s = copy.deepcopy(env["specs"][d0["id"]])
    base = env["p"].predict(s, env["ours0"], env["info"][d0["id"]])
    s["rack_power_kw"] = {n: 8.0 for n in env["ours0"]}
    r = env["p"].predict(s, env["ours0"], env["info"][d0["id"]])
    assert not r.fallback and r.corrected == base.corrected


def test_validation_mode_still_corrects_but_reports_reason(env):
    d0 = env["d0"]
    s = copy.deepcopy(env["specs"][d0["id"]])
    s["row_power_kw"] = [20.0] + s["row_power_kw"][1:]
    r = env["p"].predict(s, env["ours0"], env["info"][d0["id"]], enforce_range=False)
    assert not r.fallback and "전력" in r.reason
    assert any(abs(r.corrected[n] - env["ours0"][n]) > 1e-6 for n in r.corrected)


def test_removed_racks_are_not_predicted(env):
    d = next(x for x in env["data"] if env["specs"][x["id"]].get("remove"))
    r = env["p"].predict(env["specs"][d["id"]], dict(zip(d["names"], d["ours"])), env["info"][d["id"]])
    assert not set(env["specs"][d["id"]]["remove"]) & set(r.corrected)


def test_save_and_load_roundtrip(env, tmp_path):
    d0 = env["d0"]
    path = tmp_path / "model.pkl"
    env["p"].save(path)
    q = pr.ResidualPredictor.load(path)
    a = env["p"].predict(env["specs"][d0["id"]], env["ours0"], env["info"][d0["id"]])
    b = q.predict(env["specs"][d0["id"]], env["ours0"], env["info"][d0["id"]])
    assert all(abs(a.corrected[n] - b.corrected[n]) < 1e-9 for n in a.corrected)


def test_confidence_level_boundaries():
    assert pr.SIGMA_CAUTION < pr.SIGMA_LOW
    assert pr.INTERVAL_K > 0 and pr.INTERVAL_FLOOR > 0


def test_holdout_without_own_result_fails_outside_old_folder(tmp_path):
    """보류 사례 결과가 데이터 폴더에 없으면 이중 바닥 전 장면 결과로 조용히 바꾸지 않고 멈춘다(2026-11-13 재검토)."""
    (tmp_path / "ours_progress.json").write_text("{}", encoding="utf-8")
    spec = tmp_path / "samples.json"
    spec.write_text(json.dumps({"samples": [{"id": "holdout_A_normal", "holdout": True, "existing_of": "rack_inlet_normal.csv"}]}), encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        rm.load_dataset(tmp_path, spec)
