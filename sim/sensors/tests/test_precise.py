"""정확한 시뮬레이션 작업의 단계(precise.py): 팬 상태, 흐름 키, 평균 전력, 단계 연결(OpenFOAM과 Warp는 가짜로)."""
from __future__ import annotations

import json
import time

import pytest

from dct_sensors import jobs, precise
from dct_sensors.config import Config
from dct_sensors.solvers import make_solver


def test_fan_states_follow_failures(manifest):
    c = jobs.validate_conditions({"fans": {"crac_02": 0.5}, "failures": [{"crac": "crac_01", "t": 60}, {"crac": "crac_03", "t": 60}, {"crac": "crac_04", "t": 120}]}, manifest)
    st = precise.fan_states(c)
    assert [t for t, _ in st] == [0, 60, 120]
    assert st[0][1]["crac_01"] == 1.0 and st[0][1]["crac_02"] == 0.5
    assert st[1][1]["crac_01"] == 0.0 and st[1][1]["crac_03"] == 0.0 and st[1][1]["crac_04"] == 1.0
    assert st[2][1]["crac_04"] == 0.0


def test_flow_key_and_names():
    a = precise.flow_key({"crac_01": 1.0, "crac_02": 0.0}, {"Rack_01": 7.5})
    assert a == precise.flow_key({"crac_02": 0.0, "crac_01": 1.0}, {"Rack_01": 7.5})
    assert a != precise.flow_key({"crac_01": 1.0, "crac_02": 0.0}, {"Rack_01": 7.6})
    assert precise.eq_name("crac_02") == "CRAC_02" and precise.eq_name("rack_15") == "Rack_15"


def test_mean_rack_power_scales(manifest):
    cfg = Config()
    base = precise.mean_rack_power(manifest, cfg, jobs.validate_conditions({}, manifest))
    c = jobs.validate_conditions({"power": {"row:01": 1.2, "rack_02": 0.5}}, manifest)
    kw = precise.mean_rack_power(manifest, cfg, c)
    assert kw["Rack_01"] == pytest.approx(base["Rack_01"] * 1.2, abs=2e-3)  # 두 값을 각각 소수 셋째 자리로 반올림
    assert kw["Rack_02"] == pytest.approx(base["Rack_02"] * 0.5, abs=2e-3)  # 랙 지정이 줄 지정보다 우선
    assert kw["Rack_04"] == base["Rack_04"]  # 2번 줄은 그대로
    assert all(cfg.power_base_min <= v <= cfg.power_base_max for v in base.values())


class FakeRunner:
    def __init__(self):
        self.calls = []

    def flow(self, fan, kw, progress, check):
        self.calls.append(dict(fan))
        progress(0.5)
        check()
        progress(1.0)
        return "fake.npz", {"converged": len(self.calls) == 1, "iterations": 1500}


def test_precise_job_end_to_end_with_fakes(manifest, tmp_path):
    pytest.importorskip("pxr")
    runner = FakeRunner()
    seen = {}

    def factory(cond, flows, cfg):
        seen["flows"] = flows
        return make_solver("l0", manifest, cfg)

    mgr = jobs.JobManager(manifest, tmp_path, precise.make_stages(manifest, runner=runner, solver_factory=factory))
    try:
        j = mgr.submit({"duration": 60, "failures": [{"crac": "crac_01", "t": 30}]})
        end = time.time() + 30
        while mgr.status(j["id"])["state"] not in ("done", "failed") and time.time() < end:
            time.sleep(0.05)
        st = mgr.status(j["id"])
        assert st["state"] == "done", st["error"]
        assert len(runner.calls) == 2 and len(seen["flows"]) == 2  # 고장 전과 뒤, 팬 상태 2개
        assert any("수렴" in n for n in st["notes"])  # 두 번째 흐름은 수렴 못 함으로 표시
        rec = json.loads(mgr.result_path(j["id"]).read_text(encoding="utf-8"))
        assert rec["n"] >= 60 and rec["meta"]["job"]["precise"] is True
        folder = tmp_path / j["key"]
        assert (folder / "job.usda").exists() and (folder / "flows.json").exists()
    finally:
        mgr.stop()
