"""서버 데이터 API 시험: 목록, 녹화, 경로 제한, 출처(CORS), 압축, 속도 제한, 같은 포트의 WebSocket과 함께 동작."""
from __future__ import annotations

import asyncio
import gzip
import json
import re
from pathlib import Path

import pytest

from dct_sensors.api import DataApi, origin_allowed

ORIGINS = [None, re.compile(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$"), "https://jangdave.github.io"]
REPO = Path(__file__).resolve().parents[3]
WEB_DATA = REPO / "web" / "viewer" / "public" / "data"


@pytest.fixture
def data_dir(tmp_path):
    (tmp_path / "rec").mkdir()
    index = [
        {"id": "normal", "title": "정상", "note": "", "group": "event", "n": 3, "bytes": 10},
        {"id": "supply_18", "title": "급기 18", "note": "", "group": "supply", "value": 18, "file": "normal", "n": 3, "bytes": 10},
    ]
    (tmp_path / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "library.json").write_text(json.dumps({"version": 1, "groups": [{"id": "event", "title": "이상 상황"}]}), encoding="utf-8")
    rec = {"version": 1, "scenario": "normal", "n": 3, "pad": "x" * 3000}  # 압축이 일어나도록 1 KB보다 크게
    (tmp_path / "rec" / "normal.json").write_text(json.dumps(rec), encoding="utf-8")
    (tmp_path / "secret.txt").write_text("비밀", encoding="utf-8")
    return tmp_path


def make(data_dir, clock=None):
    kw = {"clock": clock} if clock else {}
    return DataApi(data_dir, ORIGINS, {"name": "t", "solver": "l0"}, **kw)


def get(api, path, **headers):
    return api.route("GET", path, headers)


def test_non_api_paths_go_to_websocket(data_dir):
    api = make(data_dir)
    assert get(api, "/ws") is None
    assert get(api, "/") is None


def test_health_and_meta(data_dir):
    api = make(data_dir)
    assert json.loads(get(api, "/healthz").body) == {"ok": True, "solver": "l0"}
    meta = json.loads(get(api, "/api/meta").body)
    assert meta["library"] is True and meta["libraryEntries"] == 2 and meta["solver"] == "l0"


def test_library_index_includes_groups_and_aliases(data_dir):
    r = get(make(data_dir), "/api/library")
    assert r.status == 200 and r.headers["Content-Type"].startswith("application/json")
    d = json.loads(r.body)
    assert [i["id"] for i in d["index"]] == ["normal", "supply_18"] and d["groups"][0]["id"] == "event"


def test_alias_serves_the_target_recording_and_uses_cache_headers(data_dir):
    api = make(data_dir)
    a, b = get(api, "/api/library/normal"), get(api, "/api/library/supply_18")
    assert a.status == b.status == 200 and a.body == b.body
    assert json.loads(a.body)["scenario"] == "normal"
    assert "max-age" in a.headers["Cache-Control"]


def test_gzip_only_when_accepted(data_dir):
    api = make(data_dir)
    plain = get(api, "/api/library/normal")
    zipped = get(api, "/api/library/normal", **{"Accept-Encoding": "gzip, deflate"})
    assert "Content-Encoding" not in plain.headers
    assert zipped.headers["Content-Encoding"] == "gzip" and gzip.decompress(zipped.body) == plain.body
    assert int(zipped.headers["Content-Length"]) == len(zipped.body) < len(plain.body)


@pytest.mark.parametrize("path", ["/api/library/..%2Fsecret", "/api/library/../secret.txt", "/api/library/secret", "/api/library/NORMAL", "/api/library/normal/x", "/api/nope", "/api/library/" + "a" * 60])
def test_only_listed_ids_are_served(data_dir, path):
    r = get(make(data_dir), path)
    assert r.status == 404 and r.body == b""


def test_missing_recording_file_is_404(data_dir):
    (data_dir / "rec" / "normal.json").unlink()
    assert get(make(data_dir), "/api/library/normal").status == 404


def test_read_only_methods(data_dir):
    api = make(data_dir)
    assert api.route("POST", "/api/library", {}).status == 405
    assert api.route("DELETE", "/api/library/normal", {}).status == 405
    assert api.route("OPTIONS", "/api/library", {"Origin": "https://jangdave.github.io"}).status == 204
    head = api.route("HEAD", "/api/library/normal", {})
    assert head.status == 200 and head.body == b"" and int(head.headers["Content-Length"]) > 0


def test_cors_header_only_for_allowed_origins(data_dir):
    api = make(data_dir)
    ok = get(api, "/api/library", Origin="https://jangdave.github.io")
    assert ok.headers["Access-Control-Allow-Origin"] == "https://jangdave.github.io"
    assert "Access-Control-Allow-Origin" in get(api, "/api/library", Origin="http://localhost:5173").headers
    assert "Access-Control-Allow-Origin" not in get(api, "/api/library", Origin="https://evil.example").headers
    assert "Access-Control-Allow-Origin" not in get(api, "/api/library").headers  # 브라우저가 아니면 필요 없다
    assert "Origin" in ok.headers["Vary"]


def test_origin_allowed_rules():
    assert origin_allowed(None, ORIGINS) and origin_allowed("http://127.0.0.1:8765", ORIGINS)
    assert not origin_allowed("https://jangdave.github.io.evil.com", ORIGINS)
    assert not origin_allowed("https://evil.example", [re.compile(r"^https://good$")])


def test_rate_limit_resets_each_second(data_dir):
    now = [100.0]
    api = make(data_dir, clock=lambda: now[0])
    codes = [get(api, "/api/meta").status for _ in range(70)]  # (/healthz는 제한 앞에서 답한다. test_auth.py)
    assert codes.count(200) == 60 and codes.count(429) == 10
    now[0] += 1.1
    assert get(api, "/api/meta").status == 200


def test_without_data_dir_the_library_is_unavailable_but_meta_works():
    api = DataApi(None, ORIGINS, {"name": "t", "solver": "l0"})
    assert get(api, "/api/library").status == 503
    assert json.loads(get(api, "/api/meta").body)["library"] is False


@pytest.mark.skipif(not (WEB_DATA / "index.json").exists(), reason="웹 자료가 없음")
def test_real_library_matches_the_web_data():
    api = DataApi(WEB_DATA, ORIGINS, {"name": "t", "solver": "l0"})
    index = json.loads((WEB_DATA / "index.json").read_text(encoding="utf-8"))
    assert set(api.files) == {i["id"] for i in index} and len(index) == 12
    for i in index:
        r = get(api, f"/api/library/{i['id']}")
        assert r.status == 200 and json.loads(r.body)["n"] == i["n"]


# ---- 실제 서버: 같은 포트에서 HTTP와 WebSocket이 함께 동작 ----
websockets = pytest.importorskip("websockets")
from dct_sensors import serve as sv  # noqa: E402
from dct_sensors.config import Config  # noqa: E402
from tests.test_serve import free_port  # noqa: E402


async def http_get(port, path, headers=None):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    lines = [f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{port}", "Connection: close"] + [f"{k}: {v}" for k, v in (headers or {}).items()]
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
    await writer.drain()
    raw = await reader.read()
    writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    hdrs = {ln.split(b": ", 1)[0].decode().lower(): ln.split(b": ", 1)[1].decode() for ln in head.split(b"\r\n")[1:] if b": " in ln}
    return status, hdrs, body


def test_server_serves_http_and_websocket_on_one_port(manifest, data_dir):
    engine = sv.Engine(manifest, Config(), "l0", "normal", seed=3)
    api = DataApi(data_dir, ORIGINS, {"name": "dct-sim-server", "solver": "l0"})

    async def main():
        port = free_port()
        ready, box = asyncio.Event(), []
        task = asyncio.create_task(sv.serve(engine, "127.0.0.1", port, speed=20.0, ready=ready, server_box=box, api=api))
        await asyncio.wait_for(ready.wait(), 5)
        try:
            st, h, body = await http_get(port, "/api/library", {"Origin": "https://jangdave.github.io"})
            assert st == 200 and h["access-control-allow-origin"] == "https://jangdave.github.io"
            assert json.loads(body)["index"][0]["id"] == "normal"
            st, _, _ = await http_get(port, "/api/library/..%2F..%2Fsecret")
            assert st == 404
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                snap = json.loads(await asyncio.wait_for(ws.recv(), 5))
                assert snap["type"] == "snapshot" and "supply" in snap["controls"]
        finally:
            box[0].stop()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    asyncio.run(main())
