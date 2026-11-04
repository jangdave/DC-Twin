"""서버 인증 시험: WebSocket 첫 메시지 토큰, HTTP Bearer, 실패 제한, 시작 규칙."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest

websockets = pytest.importorskip("websockets")

from dct_sensors import serve as sv  # noqa: E402
from dct_sensors.api import MAX_AUTH_FAILURES_PER_MINUTE, DataApi  # noqa: E402
from dct_sensors.config import Config  # noqa: E402
from tests.test_serve import free_port  # noqa: E402
from tests.test_api import http_get  # noqa: E402

TOKEN = "t" * 8 + "OK-token-1234567890"
ORIGINS = [None, re.compile(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$")]
REPO = Path(__file__).resolve().parents[3]


# ---- 단위 ----
def test_check_token_rules():
    assert sv.check_token(TOKEN) == TOKEN
    for bad in ("", "short", "has space in the token 12345", " leading-space-token-123", "tab\tinside-token-123456", 12345, None):
        with pytest.raises(ValueError, match="접근 토큰"):
            sv.check_token(bad)


def test_parse_auth():
    assert sv.parse_auth('{"type":"auth","token":"abc"}') == "abc"
    assert sv.parse_auth(b'{"type":"auth","token":"abc"}') == "abc"
    for bad in ('{"type":"control","token":"abc"}', '{"type":"auth"}', '{"type":"auth","token":5}', "not json", '{"type":"auth","token":"' + "x" * 300 + '"}', "x" * 2000, None, 5, "[]"):
        assert sv.parse_auth(bad) is None


def test_validate_control_ignores_auth_message_on_an_open_server(manifest):
    assert sv.validate_control('{"type":"auth","token":"whatever"}', manifest) == {"kind": "auth"}


# ---- WebSocket ----
def run_server(manifest, body, token=TOKEN, speed=20.0, api=None):
    engine = sv.Engine(manifest, Config(), "l0", "normal", seed=3)

    async def main():
        port = free_port()
        ready, box = asyncio.Event(), []
        task = asyncio.create_task(sv.serve(engine, "127.0.0.1", port, speed=speed, ready=ready, server_box=box, api=api, token=token))
        await asyncio.wait_for(ready.wait(), 5)
        try:
            return await asyncio.wait_for(body(port, box[0]), 20)
        finally:
            box[0].stop()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    return asyncio.run(main())


async def connect(port):
    return await websockets.connect(f"ws://127.0.0.1:{port}/ws")


async def closed_code(ws, timeout=5):
    try:
        await asyncio.wait_for(ws.recv(), timeout)
    except websockets.ConnectionClosed as e:
        return e.rcvd.code if e.rcvd else None
    return "열려 있음"


def test_correct_token_gets_ack_then_snapshot_and_can_control(manifest):
    async def body(port, srv):
        async with await connect(port) as ws:
            await ws.send(json.dumps({"type": "auth", "token": TOKEN}))
            assert json.loads(await ws.recv()) == {"type": "auth", "ok": True}
            snap = json.loads(await ws.recv())
            assert snap["type"] == "snapshot" and snap["controls"]["supply"] == 18.0
            await ws.send(json.dumps({"type": "control", "kind": "supply_temp", "value": 21}))
            for _ in range(400):
                m = json.loads(await ws.recv())
                if m.get("kind") == "supply_temp":
                    assert m["value"] == 21.0
                    return
            raise AssertionError("조작 사건이 오지 않았다")

    run_server(manifest, body)


def test_wrong_token_is_closed_with_policy_code_and_gets_no_data(manifest):
    async def body(port, srv):
        ws = await connect(port)
        await ws.send(json.dumps({"type": "auth", "token": "wrong-token-123456789"}))
        assert await closed_code(ws) == 1008  # 틀린 토큰: 값(snapshot)을 한 줄도 보내지 않고 닫는다
        assert srv.clients == set()

    run_server(manifest, body)


def test_control_message_before_auth_is_refused_and_does_not_leak_snapshot(manifest):
    async def body(port, srv):
        ws = await connect(port)
        await ws.send(json.dumps({"type": "control", "kind": "supply_temp", "value": 25}))
        assert await closed_code(ws) == 1008
        assert srv.engine.cfg.t_supply == 18.0  # 조작이 적용되지 않았다

    run_server(manifest, body)


def test_no_message_within_timeout_is_closed(manifest, monkeypatch):
    monkeypatch.setattr(sv, "AUTH_TIMEOUT_S", 0.3)

    async def body(port, srv):
        ws = await connect(port)  # 아무것도 보내지 않는다
        assert await closed_code(ws, timeout=3) == 1008

    run_server(manifest, body)


def test_repeated_failures_from_one_address_are_blocked_even_with_the_right_token(manifest):
    async def body(port, srv):
        for _ in range(sv.AUTH_FAILS_PER_MINUTE):
            ws = await connect(port)
            await ws.send(json.dumps({"type": "auth", "token": "wrong-token-123456789"}))
            assert await closed_code(ws) == 1008
        ws = await connect(port)
        try:
            await ws.send(json.dumps({"type": "auth", "token": TOKEN}))  # 맞는 토큰이어도 잠시 막는다(무차별 대입 방지)
        except websockets.ConnectionClosed:
            pass  # 서버가 인증을 받기도 전에 닫았다
        assert await closed_code(ws) == 1013

    run_server(manifest, body)


def test_block_expires_after_a_minute(manifest):
    srv = sv.Server(sv.Engine(manifest, Config(), "l0", "normal", seed=3), token=TOKEN, clock=lambda: now[0])
    now = [1000.0]
    for _ in range(sv.AUTH_FAILS_PER_MINUTE):
        srv._record_fail("1.2.3.4")
    assert srv._blocked("1.2.3.4") and not srv._blocked("5.6.7.8")
    now[0] += 61
    assert not srv._blocked("1.2.3.4")


def test_without_token_the_server_behaves_as_before_and_ignores_a_sent_token(manifest):
    async def body(port, srv):
        async with await connect(port) as ws:
            first = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert first["type"] == "snapshot"  # 인증 응답 없이 바로 snapshot
            await ws.send(json.dumps({"type": "auth", "token": "anything"}))  # 인증이 꺼진 서버에 토큰을 보내도 오류가 되지 않는다
            await ws.send(json.dumps({"type": "control", "kind": "speed", "value": 2}))
            await asyncio.sleep(0.3)

    run_server(manifest, body, token=None)


# ---- HTTP ----
def api_with(token, public=False, clock=None):
    kw = {"clock": clock} if clock else {}
    return DataApi(REPO / "web" / "viewer" / "public" / "data", ORIGINS, {"solver": "l0"}, token=token, public_data=public, **kw)


def bearer(t=TOKEN):
    return {"Authorization": f"Bearer {t}"}


def test_http_requires_bearer_except_healthz():
    api = api_with(TOKEN)
    assert api.route("GET", "/healthz", {}).status == 200
    for path in ("/api/meta", "/api/library", "/api/library/normal"):
        assert api.route("GET", path, {}).status == 401
        assert api.route("GET", path, {"Authorization": "Bearer wrong-token-123456789"}).status == 401
        assert api.route("GET", path, {"Authorization": TOKEN}).status == 401  # Bearer 접두어가 없다
        assert api.route("GET", path, bearer()).status == 200
    r = api.route("GET", "/api/library", {})
    assert r.headers["WWW-Authenticate"] == "Bearer" and r.body == b""


def test_http_without_token_is_open_as_before():
    assert api_with(None).route("GET", "/api/library", {}).status == 200


def test_data_api_is_public_by_default_even_with_a_token_but_private_mode_can_be_chosen():
    default = DataApi(REPO / "web" / "viewer" / "public" / "data", ORIGINS, {"solver": "l0"}, token=TOKEN)
    assert default.route("GET", "/api/library", {}).status == 200 and default.route("GET", "/api/meta", {}).status == 200
    api = api_with(TOKEN, public=True)
    assert api.route("GET", "/api/meta", {}).status == 200
    assert api.route("GET", "/api/library/normal", {}).status == 200
    assert api.route("GET", "/api/nothing", {}).status == 401  # 목록에 없는 경로는 토큰이 없으면 404도 알려 주지 않는다


def test_preflight_allows_the_authorization_header_and_401_still_carries_cors_for_allowed_origin():
    api = api_with(TOKEN, public=False)
    pre = api.route("OPTIONS", "/api/library", {"Origin": "http://localhost:5173"})
    assert pre.status == 204 and "Authorization" in pre.headers["Access-Control-Allow-Headers"]
    r = api.route("GET", "/api/library", {"Origin": "http://localhost:5173"})
    assert r.status == 401 and r.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"  # 화면이 401을 읽어 "토큰 필요"를 알릴 수 있다
    assert "Access-Control-Allow-Origin" not in api.route("GET", "/api/library", {"Origin": "https://evil.example"}).headers


def test_too_many_wrong_tokens_get_429_and_expire():
    now = [100.0]
    api = api_with(TOKEN, clock=lambda: now[0])
    codes = []
    for _ in range(MAX_AUTH_FAILURES_PER_MINUTE + 3):
        codes.append(api.route("GET", "/api/library", {"Authorization": "Bearer wrong-token-123456789"}).status)
        now[0] += 0.05  # 초당 요청 제한(60)에 걸리지 않게 천천히
    assert codes[:MAX_AUTH_FAILURES_PER_MINUTE] == [401] * MAX_AUTH_FAILURES_PER_MINUTE and codes[-3:] == [429] * 3
    now[0] += 61
    assert api.route("GET", "/api/library", bearer()).status == 200


def test_real_server_http_with_and_without_token(manifest):
    api = DataApi(REPO / "web" / "viewer" / "public" / "data", ORIGINS, {"solver": "l0"}, token=TOKEN, public_data=False)

    async def body(port, srv):
        st, h, _ = await http_get(port, "/api/library")
        assert st == 401 and h["www-authenticate"] == "Bearer"
        st, _, b = await http_get(port, "/api/library", bearer())
        assert st == 200 and len(json.loads(b)["index"]) == 12
        st, _, _ = await http_get(port, "/healthz")
        assert st == 200

    run_server(manifest, body, api=api)


# ---- 시작 규칙 ----
MANIFEST = REPO / "server" / "data" / "sensor_manifest.json"


def test_remote_bind_requires_a_token(capsys):
    assert sv.main(["--manifest", str(MANIFEST), "--host", "0.0.0.0", "--allow-remote"]) == 2
    assert "접근 토큰이 필요하다" in capsys.readouterr().err


def test_weak_token_is_refused_at_start(capsys):
    assert sv.main(["--manifest", str(MANIFEST), "--token", "short"]) == 2
    assert "16자 이상" in capsys.readouterr().err


def test_remote_bind_without_allow_remote_is_still_refused_even_with_a_token(capsys):
    assert sv.main(["--manifest", str(MANIFEST), "--host", "0.0.0.0", "--token", TOKEN]) == 2
    assert "--allow-remote" in capsys.readouterr().err


def test_token_comes_from_the_environment_too(monkeypatch, capsys):
    monkeypatch.setenv("DCT_TOKEN", "short")
    assert sv.main(["--manifest", str(MANIFEST)]) == 2  # 환경 변수로 준 토큰도 같은 규칙으로 검사한다
    assert "16자 이상" in capsys.readouterr().err


def test_no_auth_flag_is_the_only_way_to_open_remote_without_a_token(monkeypatch):
    called = {}

    def fake_run(coro):
        coro.close()
        called["ok"] = True

    monkeypatch.setattr(sv.asyncio, "run", fake_run)
    assert sv.main(["--manifest", str(MANIFEST), "--host", "0.0.0.0", "--allow-remote", "--no-auth"]) == 0 and called["ok"]
