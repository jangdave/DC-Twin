"""서버의 시뮬레이션 작업 메시지(docs/31): 제출, 진행 알림, 결과 받기, 거절. 계산은 가짜 단계로."""
from __future__ import annotations

import asyncio
import json

import pytest

websockets = pytest.importorskip("websockets")

from dct_sensors import jobs  # noqa: E402
from dct_sensors import serve as sv  # noqa: E402
from dct_sensors.config import Config  # noqa: E402

from test_serve import free_port, recv_until  # noqa: E402


def fake_stages():
    def stage(name):
        def fn(ctx):
            for k in range(1, 3):
                ctx.check()
                ctx.progress(k / 2)
            if name == "result":
                (ctx.folder / "result.json").write_text(json.dumps({"version": 1, "n": 1, "dt": 1, "values": {}}), encoding="utf-8")
        return fn
    return {s: stage(s) for s in ("usd", "steady", "transient", "result")}


def run(manifest, tmp_path, body, with_jobs=True):
    async def main():
        engine = sv.Engine(manifest, Config(), "l0", "normal", seed=3)
        mgr = jobs.JobManager(manifest, tmp_path, fake_stages()) if with_jobs else None
        port = free_port()
        ready, box = asyncio.Event(), []
        task = asyncio.create_task(sv.serve(engine, "127.0.0.1", port, speed=20.0, ready=ready, server_box=box, jobs=mgr))
        await asyncio.wait_for(ready.wait(), 5)
        try:
            return await asyncio.wait_for(body(f"ws://127.0.0.1:{port}/ws"), 20)
        finally:
            box[0].stop()
            if mgr:
                mgr.stop()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    return asyncio.run(main())


def test_parse_job_message():
    assert sv.parse_job_message('{"type":"control","kind":"speed","value":1}') is None
    assert sv.parse_job_message('{"type":"job","action":"list"}') == {"action": "list"}
    assert sv.parse_job_message('{"type":"job","action":"status","id":"abc123"}')["id"] == "abc123"
    for bad in ('{"type":"job","action":"drop"}', '{"type":"job","action":"status","id":"../x"}', '{"type":"job","action":"submit","conditions":1}'):
        with pytest.raises(ValueError):
            sv.parse_job_message(bad)
    with pytest.raises(ValueError, match="크다"):
        sv.parse_job_message('{"type":"job","action":"list","pad":"' + "x" * 20000 + '"}')


def test_submit_progress_and_result(manifest, tmp_path):
    async def body(url):
        async with websockets.connect(url, max_size=None) as ws:
            await ws.send(json.dumps({"type": "job", "action": "submit", "conditions": {"duration": 60}}))
            first = await recv_until(ws, lambda m: m.get("type") == "job")
            jid = first["job"]["id"]
            done = await recv_until(ws, lambda m: m.get("type") == "job" and m["job"]["id"] == jid and m["job"]["state"] == "done")
            await ws.send(json.dumps({"type": "job", "action": "result", "id": jid}))
            res = await recv_until(ws, lambda m: m.get("type") == "job_result")
            await ws.send(json.dumps({"type": "job", "action": "list"}))
            lst = await recv_until(ws, lambda m: m.get("type") == "job_list")
            await ws.send(json.dumps({"type": "job", "action": "submit", "conditions": {"duration": 5}}))
            err = await recv_until(ws, lambda m: m.get("type") == "error")
            return first, done, res, lst, err

    first, done, res, lst, err = run(manifest, tmp_path, body)
    assert [s["id"] for s in first["job"]["stages"]] == ["usd", "steady", "transient", "result"]
    assert done["job"]["progress"] == 1.0
    assert res["rec"]["version"] == 1
    assert any(j["id"] == first["job"]["id"] for j in lst["jobs"])
    assert "길이" in err["message"]  # 조건 검사 오류가 그대로 보인다


def test_jobs_off_rejects(manifest, tmp_path):
    async def body(url):
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "job", "action": "list"}))
            return await recv_until(ws, lambda m: m.get("type") == "error")

    err = run(manifest, tmp_path, body, with_jobs=False)
    assert "--jobs" in err["message"]


def test_process_request_legacy_api(manifest, tmp_path):
    """Kit 안의 websockets 12(옛 API: (path, request_headers), 돌려주는 값은 (상태, 헤더, 본문))도 데이터 API를 받는다."""
    from dct_sensors.api import DataApi

    engine = sv.Engine(manifest, Config(), "l0", "normal", seed=3)
    api = DataApi(None, sv.DEFAULT_ORIGINS, meta={"name": "t"})
    srv = sv.Server(engine, api=api)

    class LegacyHeaders(dict):
        pass  # 옛 API의 요청 헤더는 .headers가 없는 사전 같은 것

    out = asyncio.run(srv.process_request("/api/meta", LegacyHeaders()))
    status, headers, body = out
    assert status == 200 and json.loads(body)["name"] == "t" and isinstance(headers, list)
    assert asyncio.run(srv.process_request("/ws", LegacyHeaders({"Upgrade": "websocket"}))) is None
