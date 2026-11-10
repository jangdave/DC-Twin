"""시뮬레이션 작업(jobs.py): 조건 검사, USD 층, 웹 녹화 변환, 대기열과 취소 (docs/31, docs/32)."""
from __future__ import annotations

import json
import threading
import time

import pytest

from dct_sensors import jobs, serve
from dct_sensors.config import Config
from dct_sensors.generator import Generator
from dct_sensors.solvers import make_solver


def test_ranges_match_server_controls():
    assert jobs.SUPPLY_RANGE == serve.SUPPLY_RANGE
    assert jobs.POWER_RANGE == serve.POWER_RANGE


def test_validate_defaults_and_shape(manifest):
    c = jobs.validate_conditions({}, manifest)
    assert c["duration"] == 300 and c["supply"] == 18.0 and c["precise"] is True
    assert c["fans"] == {n: 1.0 for n in manifest.cracs}
    assert c["power"] == {} and c["failures"] == []


@pytest.mark.parametrize("raw, msg", [
    ({"duration": 30}, "길이"),
    ({"supply": 40}, "급기"),
    ({"fans": {"crac_99": 1}}, "알 수 없는 CRAC"),
    ({"fans": {"crac_01": 1.5}}, "팬 속도"),
    ({"power": {"row:09": 1.2}}, "알 수 없는 랙이나 줄"),
    ({"power": {"rack_01": 9}}, "전력 배수"),
    ({"failures": [{"crac": "crac_01", "t": 400}]}, "고장 시각"),
    ({"failures": [{"crac": "crac_01", "t": 10}, {"crac": "crac_01", "t": 20}]}, "두 번"),
    ({"precise": "yes"}, "precise"),
    ({"weather": 1}, "알 수 없는 조건"),
    ({"supply": True}, "급기"),
])
def test_validate_rejects(manifest, raw, msg):
    with pytest.raises(ValueError, match=msg):
        jobs.validate_conditions(raw, manifest)


def test_key_is_stable_and_order_free(manifest):
    a = jobs.validate_conditions({"power": {"row:02": 1.2, "rack_01": 0.8}, "fans": {"crac_02": 0.5}}, manifest)
    b = jobs.validate_conditions({"fans": {"crac_02": 0.5}, "power": {"rack_01": 0.8, "row:02": 1.2}}, manifest)
    assert jobs.condition_key(a) == jobs.condition_key(b)
    c = jobs.validate_conditions({"fans": {"crac_02": 0.6}}, manifest)
    assert jobs.condition_key(a) != jobs.condition_key(c)
    # 1.0 배수는 기본값과 같으므로 빠진다(같은 조건이면 같은 키)
    assert jobs.condition_key(jobs.validate_conditions({"power": {"row:01": 1.0}}, manifest)) == jobs.condition_key(jobs.validate_conditions({}, manifest))


def test_scenario_events(manifest):
    c = jobs.validate_conditions({"fans": {"crac_02": 0.5}, "power": {"rack_01": 1.4, "row:01": 1.2}, "failures": [{"crac": "crac_03", "t": 60}]}, manifest)
    ev = jobs.scenario_from_conditions(c).events
    assert [(e.t, e.kind, e.target, e.value) for e in ev] == [
        (0, "crac_fan", "crac_02", 0.5), (0, "rack_power_scale", "row:01", 1.2), (0, "rack_power_scale", "rack_01", 1.4), (60, "crac_fan", "crac_03", 0.0)]


def test_usd_layer_roundtrip(manifest, tmp_path):
    pytest.importorskip("pxr")
    c = jobs.validate_conditions({"duration": 600, "supply": 21.5, "precise": False, "fans": {"crac_02": 0.4},
                                  "power": {"row:02": 1.3, "rack_01": 0.7}, "failures": [{"crac": "crac_03", "t": 120}]}, manifest)
    text = jobs.conditions_to_usda(c, manifest, "D:/Test/usd/scenes/hall01.usda")
    assert text.startswith("#usda 1.0") and "dct:job:fanRatio" in text and "subLayers" in text
    p = tmp_path / "job.usda"
    p.write_text(text, encoding="utf-8")
    assert jobs.conditions_from_usd(p, manifest) == c


def _small_run(manifest, seconds=5):
    cfg = Config()
    gen = Generator(manifest, jobs.scenario_from_conditions(jobs.validate_conditions({"fans": {"crac_01": 0.5}}, manifest)), make_solver("l0", manifest, cfg), cfg, seed=1)
    return list(gen.run(seconds))


def test_web_recording_shape(manifest):
    msgs = _small_run(manifest, 5)
    ids = [s.sensor_id for s in manifest.sensors]
    rec = jobs.to_web_recording(msgs, "custom", ids)
    assert rec["version"] == 1 and rec["dt"] == 1 and rec["n"] >= 5
    for i in ids:
        assert len(rec["values"][i]) == rec["n"]
        assert all(v is None or isinstance(v, float) for v in rec["values"][i])
    assert set(rec["aggregates"]) == set(jobs.AGGREGATES)
    assert any(e["kind"] == "crac_fan" and e["target"] == "crac_01" for e in rec["events"])
    json.dumps(rec)  # JSON으로 쓸 수 있다


class FakeStages:
    """단계마다 progress를 몇 번 부르고, gate가 열릴 때까지 기다릴 수 있는 가짜 계산."""

    def __init__(self, fail_stage=None):
        self.gate = threading.Event()
        self.gate.set()
        self.calls = []
        self.fail_stage = fail_stage

    def make(self, name):
        def fn(ctx):
            self.calls.append((ctx.job.id, name))
            for k in range(1, 5):
                ctx.check()
                if name == "transient":
                    self.gate.wait(5)
                ctx.progress(k / 4)
            if name == self.fail_stage:
                raise RuntimeError("계산 실패 흉내")
            if name == "transient":
                (ctx.folder / "preview.json").write_text("{}", encoding="utf-8")
            if name == "result":
                (ctx.folder / "result.json").write_text("{}", encoding="utf-8")
        return fn

    def all(self):
        return {s: self.make(s) for s in ("usd", "transient", "steady", "result")}


def wait_state(mgr, jid, states, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        st = mgr.status(jid)
        if st["state"] in states:
            return st
        time.sleep(0.01)
    raise AssertionError(f"{jid}: {mgr.status(jid)['state']}")


def test_manager_runs_stages_and_reuses_result(manifest, tmp_path):
    fs = FakeStages()
    mgr = jobs.JobManager(manifest, tmp_path, fs.all())
    try:
        s = mgr.submit({"precise": True})
        assert [x["id"] for x in s["stages"]] == ["usd", "transient", "steady", "result"]
        done = wait_state(mgr, s["id"], {"done"})
        assert done["progress"] == 1.0 and done["preview"] is True and done["etaS"] == 0.0
        assert mgr.result_path(s["id"]).exists()
        again = mgr.submit({"precise": True})  # 같은 조건: 다시 계산하지 않는다
        assert again["state"] == "done" and again["cached"] is True
        assert len([c for c in fs.calls if c[1] == "usd"]) == 1
        quick = mgr.submit({"precise": False})
        assert [x["id"] for x in quick["stages"]] == ["usd", "transient", "result"]
    finally:
        mgr.stop()


def test_queue_limit_cancel_and_failure(manifest, tmp_path):
    fs = FakeStages()
    fs.gate.clear()  # 첫 작업을 시간 변화 단계에서 붙잡아 둔다
    mgr = jobs.JobManager(manifest, tmp_path, fs.all(), max_queue=2)
    try:
        first = mgr.submit({"supply": 18})
        wait_state(mgr, first["id"], {"running"})
        a = mgr.submit({"supply": 19})
        b = mgr.submit({"supply": 20})
        assert a["position"] == 1 and b["position"] == 2
        assert a["etaS"] < b["etaS"]  # 뒤에 선 작업일수록 남은 시간이 길다
        dup = mgr.submit({"supply": 19})  # 대기 중인 같은 조건은 그 작업을 돌려준다
        assert dup["id"] == a["id"]
        with pytest.raises(ValueError, match="대기열"):
            mgr.submit({"supply": 21})
        assert mgr.cancel(a["id"])["state"] == "cancelled"
        assert mgr.status(b["id"])["position"] == 1
        mgr.cancel(first["id"])  # 도는 중인 작업 취소
        fs.gate.set()
        assert wait_state(mgr, first["id"], {"cancelled"})["state"] == "cancelled"
        assert wait_state(mgr, b["id"], {"done"})["state"] == "done"
    finally:
        mgr.stop()
    fs2 = FakeStages(fail_stage="transient")
    mgr2 = jobs.JobManager(manifest, tmp_path / "f", fs2.all())
    try:
        j = mgr2.submit({})
        st = wait_state(mgr2, j["id"], {"failed"})
        assert "계산 실패 흉내" in st["error"]
        with pytest.raises(FileNotFoundError):
            mgr2.result_path(j["id"])
    finally:
        mgr2.stop()


def test_progress_and_eta_move_forward(manifest, tmp_path):
    seen = []
    fs = FakeStages()
    mgr = jobs.JobManager(manifest, tmp_path, fs.all())
    mgr.listeners.append(lambda s: seen.append((s["progress"], s["etaS"], s["state"])))
    try:
        j = mgr.submit({})
        wait_state(mgr, j["id"], {"done"})
    finally:
        mgr.stop()
    prog = [p for p, _, st in seen if st == "running"]
    assert prog == sorted(prog) and prog[-1] > 0.9
    assert seen[-1][2] == "done"


def test_estimates_learn(tmp_path):
    book = jobs.EstimateBook(tmp_path / "e.json")
    assert book.expect("transient", 600) == pytest.approx(jobs.DEFAULT_SECONDS["transient"] * 2)
    book.learn("transient", 300, 30.0)
    assert book.expect("transient", 300) == pytest.approx(30.0)
    assert jobs.EstimateBook(tmp_path / "e.json").expect("transient", 300) == pytest.approx(30.0)  # 파일에 남는다
