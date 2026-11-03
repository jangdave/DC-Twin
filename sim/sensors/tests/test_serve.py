"""로컬 계산 서버 시험: 조작 검사, snapshot, 조작 반영, 출처·크기·횟수 제한."""
from __future__ import annotations

import asyncio
import json
import socket

import pytest

websockets = pytest.importorskip("websockets")

from dct_sensors import serve as sv  # noqa: E402
from dct_sensors.config import Config  # noqa: E402


@pytest.fixture
def engine(manifest):
    return sv.Engine(manifest, Config(), "l0", "normal", seed=3)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_with_server(engine, body, speed=20.0):
    """서버를 띄우고 body(url, srv)를 돌린 뒤 끈다."""

    async def main():
        port = free_port()
        ready, box = asyncio.Event(), []
        task = asyncio.create_task(sv.serve(engine, "127.0.0.1", port, speed=speed, ready=ready, server_box=box))
        await asyncio.wait_for(ready.wait(), 5)
        try:
            return await asyncio.wait_for(body(f"ws://127.0.0.1:{port}/ws", box[0]), 20)
        finally:
            box[0].stop()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    return asyncio.run(main())


async def recv_until(ws, pred, limit=3000):
    for _ in range(limit):
        m = json.loads(await ws.recv())
        if pred(m):
            return m
    raise AssertionError("기다리던 메시지가 오지 않았다")


class TestValidate:
    def test_valid(self, manifest):
        assert sv.validate_control('{"type":"control","kind":"crac_fan","target":"crac_02","value":0}', manifest) == {"kind": "crac_fan", "target": "crac_02", "value": 0.0}
        assert sv.validate_control('{"type":"control","kind":"rack_power_scale","target":"row:02","value":1.5}', manifest)["target"] == "row:02"
        assert sv.validate_control('{"type":"control","kind":"rack_power_scale","target":"rack_01","value":0}', manifest)["value"] == 0.0
        assert sv.validate_control('{"type":"control","kind":"scenario","name":"cooling_failure"}', manifest) == {"kind": "scenario", "name": "cooling_failure"}
        assert sv.validate_control('{"type":"control","kind":"speed","value":5}', manifest)["value"] == 5.0

    @pytest.mark.parametrize("raw", [
        "not json", "[]", '{"type":"sample"}', '{"type":"control"}', '{"type":"control","kind":"reboot"}',
        '{"type":"control","kind":"crac_fan","target":"crac_99","value":0.5}',
        '{"type":"control","kind":"crac_fan","target":"crac_01","value":1.5}',
        '{"type":"control","kind":"crac_fan","target":"crac_01","value":-0.1}',
        '{"type":"control","kind":"crac_fan","target":"crac_01","value":true}',
        '{"type":"control","kind":"crac_fan","target":"crac_01","value":"1"}',
        '{"type":"control","kind":"crac_fan","target":"crac_01","value":NaN}',
        '{"type":"control","kind":"rack_power_scale","target":"row:09","value":1}',
        '{"type":"control","kind":"rack_power_scale","target":"rack_99","value":1}',
        '{"type":"control","kind":"rack_power_scale","target":"row:01","value":4}',
        '{"type":"control","kind":"scenario","name":"../etc"}',
        '{"type":"control","kind":"speed","value":100}',
    ])
    def test_invalid(self, manifest, raw):
        with pytest.raises(ValueError):
            sv.validate_control(raw, manifest)

    def test_too_big(self, manifest):
        with pytest.raises(ValueError):
            sv.validate_control(" " * 2000, manifest)


class TestEngine:
    def test_snapshot_before_and_after_steps(self, engine, manifest):
        snap = engine.state.snapshot()
        assert snap["type"] == "snapshot" and snap["scenario"] == "normal"
        assert len(snap["sensors"]) == len(manifest.sensors) and all(s["value"] is None and s["quality"] == "stale" for s in snap["sensors"])
        engine.step()
        snap = engine.state.snapshot()
        assert all(s["value"] is not None for s in snap["sensors"]) and snap["aggregates"]["it_power"]["value"] > 0

    def test_snapshot_carries_controls(self, engine):
        engine.step()
        engine.control("crac_fan", "crac_02", 0.25)
        engine.control("rack_power_scale", "row:02", 1.5)
        c = engine.state.snapshot()["controls"]
        assert c["fan"]["crac_02"] == 0.25 and c["fan"]["crac_01"] == 1.0
        assert c["powerScale"]["rack_04"] == 1.5 and c["powerScale"]["rack_01"] == 1.0  # 시험 홀: 2번 줄 = rack_04~06

    def test_control_changes_fan_and_event(self, engine):
        engine.step()
        ev = engine.control("crac_fan", "crac_02", 0.0)
        assert ev["type"] == "scenario" and ev["event"] == "event" and ev["kind"] == "crac_fan" and ev["value"] == 0.0 and ev["ts"]
        msgs = engine.step()
        fan = [m for m in msgs if m["type"] == "sample" and m["sensorId"].endswith("-FAN-SPEED") and "CR02" in m["sensorId"]]
        assert fan and fan[0]["value"] < 1.0

    def test_scenario_restart_clears_state(self, engine):
        for _ in range(3):
            engine.step()
        start = engine.start("cooling_failure")
        assert start["event"] == "start" and start["name"] == "cooling_failure"
        assert engine.state.snapshot()["scenario"] == "cooling_failure" and not engine.state.latest
        assert engine.t == 0.0

    def test_control_bad_target_raises(self, engine):
        with pytest.raises(ValueError):
            engine.control("crac_fan", "crac_99", 0.5)


class TestServer:
    def test_snapshot_then_samples_and_control(self, engine):
        async def body(url, srv):
            async with websockets.connect(url) as ws:
                snap = json.loads(await ws.recv())
                assert snap["type"] == "snapshot" and snap["scenario"] == "normal"
                await recv_until(ws, lambda m: m["type"] == "sample")
                await ws.send(json.dumps({"type": "control", "kind": "crac_fan", "target": "crac_02", "value": 0}))
                ev = await recv_until(ws, lambda m: m["type"] == "scenario" and m.get("event") == "event")
                assert ev["kind"] == "crac_fan" and ev["target"] == "crac_02"
                # 반영 확인: 그 CRAC 팬 속도 샘플이 0 근처로 내려온다
                m = await recv_until(ws, lambda m: m["type"] == "sample" and "CR02-FAN-SPEED" in m["sensorId"] and m["value"] < 5)
                assert m["value"] < 5

        run_with_server(engine, body)

    def test_invalid_control_gets_error_only(self, engine):
        async def body(url, srv):
            async with websockets.connect(url, max_queue=None) as a, websockets.connect(url, max_queue=None) as b:
                await a.recv(), await b.recv()
                await a.send(json.dumps({"type": "control", "kind": "crac_fan", "target": "crac_99", "value": 0}))
                err = await recv_until(a, lambda m: m["type"] == "error")
                assert "CRAC" in err["message"]
                # 다른 접속에는 오류가 가지 않는다
                for _ in range(40):
                    assert json.loads(await b.recv())["type"] != "error"

        run_with_server(engine, body)

    def test_scenario_restart_broadcasts_start(self, engine):
        async def body(url, srv):
            async with websockets.connect(url) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "control", "kind": "scenario", "name": "power_spike"}))
                m = await recv_until(ws, lambda m: m["type"] == "scenario" and m.get("event") == "start")
                assert m["name"] == "power_spike"

        run_with_server(engine, body)

    def test_speed_control_changes_pace(self, engine):
        async def body(url, srv):
            async with websockets.connect(url) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "control", "kind": "speed", "value": 7}))
                await asyncio.sleep(0.3)
                assert srv.speed == 7.0

        run_with_server(engine, body)

    def test_bad_origin_rejected_and_local_origin_allowed(self, engine):
        async def body(url, srv):
            with pytest.raises(websockets.exceptions.InvalidStatus):
                async with websockets.connect(url, origin="https://evil.example"):
                    pass
            async with websockets.connect(url, origin="http://localhost:5173") as ws:
                assert json.loads(await ws.recv())["type"] == "snapshot"
            async with websockets.connect(url, origin="https://jangdave.github.io") as ws:
                assert json.loads(await ws.recv())["type"] == "snapshot"

        run_with_server(engine, body)

    def test_oversize_message_closes_connection(self, engine):
        async def body(url, srv):
            async with websockets.connect(url) as ws:
                await ws.recv()
                await ws.send("x" * 5000)
                with pytest.raises(websockets.exceptions.ConnectionClosed):
                    for _ in range(200):
                        await ws.recv()

        run_with_server(engine, body)

    def test_rate_limit(self, engine):
        async def body(url, srv):
            async with websockets.connect(url) as ws:
                await ws.recv()
                for _ in range(sv.CONTROLS_PER_SECOND + 15):
                    await ws.send(json.dumps({"type": "control", "kind": "crac_fan", "target": "crac_01", "value": 1}))
                err = await recv_until(ws, lambda m: m["type"] == "error" and "잦다" in m["message"])
                assert err

        run_with_server(engine, body)

    def test_too_many_clients(self, engine, monkeypatch):
        monkeypatch.setattr(sv, "MAX_CLIENTS", 1)

        async def body(url, srv):
            async with websockets.connect(url) as a:
                await a.recv()
                async with websockets.connect(url) as b:
                    with pytest.raises(websockets.exceptions.ConnectionClosed):
                        for _ in range(5):
                            await b.recv()

        run_with_server(engine, body)


def test_refuses_non_loopback_host(manifest, tmp_path, capsys):
    mf = tmp_path / "m.json"
    from conftest import make_manifest_data

    mf.write_text(json.dumps(make_manifest_data()), encoding="utf-8")
    assert sv.main(["--manifest", str(mf), "--host", "0.0.0.0"]) == 2
    assert "막아" in capsys.readouterr().err
    assert sv.is_loopback("127.0.0.1") and sv.is_loopback("localhost") and sv.is_loopback("::1")
    assert not sv.is_loopback("192.168.0.5") and not sv.is_loopback("0.0.0.0")
