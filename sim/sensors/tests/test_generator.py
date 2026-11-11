"""생성기 시험: 재현, 시나리오 효과, 고장 주입, 메시지 형식."""
from __future__ import annotations

import json

import pytest

from conftest import make_manifest_data
from dct_sensors.__main__ import main
from dct_sensors.config import Config
from dct_sensors.generator import Generator, parse_fault
from dct_sensors.manifest import Layout, Manifest
from dct_sensors.scenarios import get
from dct_sensors.solvers import L0Solver


def run(manifest, scenario="normal", duration=300, seed=1, faults=None, cfg=None):
    cfg = cfg or Config()
    gen = Generator(manifest, get(scenario), L0Solver(manifest, cfg), cfg, seed=seed, faults=faults)
    return list(gen.run(duration))


def values(msgs, key):
    return [(m["ts"], m["value"]) for m in msgs if m["type"] == "sample" and m["topic"].endswith(key)]


def test_same_seed_same_output(manifest):
    assert run(manifest, "cooling_failure", 120, seed=7) == run(manifest, "cooling_failure", 120, seed=7)
    assert run(manifest, "normal", 60, seed=1) != run(manifest, "normal", 60, seed=2)


def test_message_format(manifest):
    msgs = run(manifest, "normal", 5)
    assert msgs[0] == {"type": "scenario", "event": "start", "name": "normal", "ts": "2026-10-15T09:00:00.000Z"}
    assert msgs[-1]["type"] == "scenario" and msgs[-1]["event"] == "end"
    samples = [m for m in msgs if m["type"] == "sample"]
    assert len(samples) == 5 * len(manifest.sensors)
    s = samples[0]
    assert set(s) == {"type", "sensorId", "topic", "ts", "value", "unit", "quality"}
    assert isinstance(s["value"], float) and s["quality"] == "good"
    assert s["topic"] == manifest.by_id[s["sensorId"]].topic and s["unit"] == manifest.by_id[s["sensorId"]].unit
    assert s["ts"].endswith("Z") and len(s["ts"]) == 24
    ts = [m["ts"] for m in samples]
    assert ts == sorted(ts)


def test_normal_has_no_bad_quality(manifest):
    # 팬 속도 100%에 잡음이 더해져 100.2가 되면 범위 밖(bad)으로 판정되던 문제
    bad = [m for m in run(manifest, "normal", 300) if m["type"] == "sample" and m["quality"] != "good"]
    assert bad == []


def test_stopped_fan_has_no_bad_quality(manifest):
    msgs = run(manifest, "cooling_failure", 200)
    fan = [m for m in msgs if m["type"] == "sample" and m["sensorId"] == "H01-CR02-FAN-SPEED"]
    assert all(m["quality"] == "good" for m in fan) and min(m["value"] for m in fan) >= 0.0


def test_normal_has_no_alarms(manifest):
    assert not [m for m in run(manifest, "normal", 600) if m["type"] == "alarm"]


def test_cooling_failure_heats_only_the_affected_aisle(manifest):
    # 줄 2개: 줄 1은 열기 통로 0(CRAC_01, CRAC_03), 줄 2는 통로 1(CRAC_02, CRAC_04). CRAC_02 정지 -> 줄 2 랙만 영향
    msgs = run(manifest, "cooling_failure", 300)
    t4 = dict(values(msgs, "rack_04/temp_in"))
    assert t4["2026-10-15T09:04:50.000Z"] - t4["2026-10-15T09:00:50.000Z"] > 8
    t1 = dict(values(msgs, "rack_01/temp_in"))
    assert t1["2026-10-15T09:04:50.000Z"] - t1["2026-10-15T09:00:50.000Z"] < 1.5
    alarms = [m for m in msgs if m["type"] == "alarm" and m["sensorId"].endswith("TEMP-IN")]
    assert alarms and all(m["sensorId"] in {f"H01-RK0{n}-TEMP-IN" for n in (4, 5, 6)} for m in alarms)
    assert {m["to"] for m in alarms} >= {"warn", "critical"}
    assert min(m["ts"] for m in alarms) > "2026-10-15T09:01:00.000Z"  # 시나리오 시작(60초) 이전에는 변화가 없다
    fan = values(msgs, "crac_02/fan_speed")
    assert fan[10][1] > 90 and fan[100][1] < 5


def test_power_spike_raises_row_power(manifest):
    msgs = run(manifest, "power_spike", 120)
    p = lambda key, t: dict(values(msgs, key))[f"2026-10-15T09:{t}.000Z"]
    assert p("rack_04/power", "01:30") > 1.25 * p("rack_04/power", "00:10") - 1.0
    assert abs(p("rack_01/power", "01:30") - p("rack_01/power", "00:10")) < 2.0  # 다른 줄은 완만하게만 변한다


def test_fan_fault_alarms(manifest):
    msgs = run(manifest, "fan_fault", 200)
    fan_alarms = [m for m in msgs if m["type"] == "alarm" and m["sensorId"] == "H01-CR01-FAN-SPEED"]
    assert [m["to"] for m in fan_alarms] == ["warn"]


def test_dropout_fault_stops_messages(manifest):
    f = parse_fault("dropout:H01-RK02-TEMP-IN:20s@10s")
    msgs = run(manifest, "normal", 60, faults=[f])
    ts = [t for t, _ in values(msgs, "rack_02/temp_in")]
    assert len(ts) == 60 - 20
    assert "2026-10-15T09:00:15.000Z" not in ts and "2026-10-15T09:00:35.000Z" in ts
    assert len(values(msgs, "rack_01/temp_in")) == 60  # 다른 센서는 그대로


def test_parse_fault_errors(manifest):
    with pytest.raises(SystemExit):
        parse_fault("dropout:H01-RK02-TEMP-IN")
    with pytest.raises(SystemExit):
        Generator(manifest, get("normal"), L0Solver(manifest, Config()), Config(), faults=[parse_fault("dropout:H99-RK99-TEMP-IN:5s")])


def test_out_of_range_value_is_bad_and_not_alarmed(manifest):
    cfg = Config()
    cfg.t_supply = 60.0  # 모든 온도가 범위(입구 10~45) 밖이 되게 한다
    msgs = run(manifest, "normal", 30, cfg=cfg)
    tin = [m for m in msgs if m["type"] == "sample" and m["topic"].endswith("/temp_in")]
    assert tin and all(m["quality"] == "bad" for m in tin)
    assert not [m for m in msgs if m["type"] == "alarm" and m["sensorId"].endswith("TEMP-IN")]


def test_aggregates_present(manifest):
    msgs = run(manifest, "normal", 10)
    last = {m["name"]: m["value"] for m in msgs if m["type"] == "aggregate"}
    assert set(last) == {"it_power", "cooling_power", "facility_power", "pue", "energy_kwh"}
    assert last["it_power"] > 0 and last["pue"] > 1.0 and last["energy_kwh"] > 0


def test_layout_rule_mismatch_is_rejected():
    data = make_manifest_data(n_rows=2)
    data["sensors"] = [s for s in data["sensors"] if "CRAC_04" not in s["usdPath"]]  # CRAC 3기: 배치 규칙과 맞지 않음
    with pytest.raises(ValueError):
        Layout.from_manifest(Manifest(data))


def test_cli_writes_jsonl(manifest_file, tmp_path):
    out = tmp_path / "rec" / "x.jsonl"
    assert main(["--manifest", str(manifest_file), "--scenario", "cooling_failure", "--duration", "90", "--time-scale", "0", "--out", str(out), "--quiet"]) == 0
    lines = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines()]
    assert lines[0]["type"] == "scenario" and any(l["type"] == "alarm" for l in lines)
