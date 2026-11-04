"""집계 공유 시험 자료와 파이썬 구현의 일치. 웹(aggregates.test.js)과 게이트웨이(aggregates.test.js)도 같은 자료를 읽는다."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from dct_sensors.aggregates import chiller_factor, cooling_power, facility_power, load_factor
from dct_sensors.config import Config

VECTORS = json.loads((Path(__file__).with_name("aggregate_vectors.json")).read_text(encoding="utf-8"))


def test_defaults_in_the_vector_file_match_the_python_config():
    """기본값이 슬그머니 바뀌면(웹과 게이트웨이가 이 값으로 시험한다) 여기서 먼저 걸린다."""
    cfg = Config()
    assert VECTORS["defaults"] == {k: getattr(cfg, k) for k in VECTORS["defaults"]}


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_python_matches_the_shared_vectors(case):
    cfg = Config(**case["cfg"])
    cool = cooling_power(cfg, case["n_crac"], case["n_racks"], case["fan_sum"], case["it_power"], case["t_supply"])
    fac = facility_power(cfg, case["it_power"], cool)
    assert abs(cool - case["cooling"]) < 1e-5
    assert abs(fac - case["facility"]) < 1e-5
    assert abs((fac / case["it_power"] if case["it_power"] > 0 else 0.0) - case["pue"]) < 1e-5


def test_stored_vectors_equal_a_fresh_build():
    """저장된 시험 자료가 지금 식의 결과와 같다(식을 바꾸고 자료를 다시 만들지 않으면 걸린다)."""
    from tests.make_aggregate_vectors import build

    fresh = build()
    assert fresh["cases"] == VECTORS["cases"] and fresh["defaults"] == VECTORS["defaults"]


def test_reference_point_is_exactly_one():
    cfg = Config()
    assert chiller_factor(cfg, 18.0) == 1.0
    assert load_factor(cfg, 440.0, 60) == pytest.approx(1.0, abs=1e-12)


def test_the_generator_uses_the_shared_function(manifest):
    """생성기의 집계가 공유 함수와 같은 값이다(식이 생성기 안에 다시 복사되지 않았다)."""
    from dct_sensors.generator import Generator
    from dct_sensors.scenarios import get
    from dct_sensors.solvers import L0Solver

    cfg = Config(t_supply=22.0)
    gen = Generator(manifest, get("normal"), L0Solver(manifest, cfg), cfg, seed=1)
    agg = {}
    for m in gen.run(2):
        if m["type"] == "aggregate":
            agg[m["name"]] = m["value"]
    n_crac, n_racks = len(manifest.cracs), len(manifest.rack_names)
    expected = cooling_power(cfg, n_crac, n_racks, float(n_crac), agg["it_power"])
    assert abs(agg["cooling_power"] - expected) < 1e-3
