"""서버의 데이터 제공 API(HTTP, 읽기 전용). 웹 보기 화면이 미리 계산한 값을 서버에서 받아 쓰게 한다.

경로(같은 포트의 WebSocket `/ws`와 함께 쓴다)
- GET /healthz                  살아 있는지와 모델 이름
- GET /api/meta                 서버가 하는 일(모델, 받는 조작 종류, 공급 온도 범위, 라이브러리 항목 수)
- GET /api/library              미리 계산한 상태와 시나리오 모음의 목록 { version, groups, index }
- GET /api/library/<id>         그 항목의 녹화(JSON). id는 목록에 있는 것만 받는다(파일 경로를 받지 않는다)

안전
- 읽기 전용(GET, HEAD, OPTIONS만). 경로는 목록에서 찾은 파일만 연다(`..`이나 임의 경로는 404).
- 웹 페이지 출처(Origin)가 허용 목록에 있을 때만 CORS 허용 머리글을 붙인다. 브라우저가 아닌 클라이언트는 그대로 받는다(공개 자료라 비밀이 아니다).
- 초당 요청 수를 제한한다(전체 합).
- 시각화 목적이며 공학적 정확성을 주장하지 않는다.
"""
from __future__ import annotations

import gzip
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
MAX_REQUESTS_PER_SECOND = 60
CACHE_SECONDS = 300
REASONS = {200: "OK", 204: "No Content", 304: "Not Modified", 404: "Not Found", 405: "Method Not Allowed", 429: "Too Many Requests", 503: "Service Unavailable"}


@dataclass
class Reply:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    @property
    def reason(self) -> str:
        return REASONS.get(self.status, "")


def origin_allowed(origin: str | None, allowed) -> bool:
    """허용 목록(None, 문자열, 정규식)과 맞는지. Origin이 없으면(브라우저가 아님) None이 목록에 있을 때 허용."""
    for a in allowed:
        if a is None:
            if origin is None:
                return True
        elif isinstance(a, str):
            if origin == a:
                return True
        elif origin is not None and a.match(origin):
            return True
    return False


class DataApi:
    def __init__(self, data_dir: Path | None, origins, meta: dict, clock=time.monotonic, extra_dirs=()):
        self.meta = meta
        self.origins = origins
        self.clock = clock
        self.index: list[dict] = []
        self.groups: list[dict] = []
        self.files: dict[str, tuple[Path, str]] = {}  # 항목 id -> (자료 폴더, 녹화 파일 이름(확장자 없음))
        self.dir = Path(data_dir) if data_dir else None
        self._cache: dict[str, tuple[bytes, bytes]] = {}  # 키 -> (원본, gzip)
        self._window = (clock(), 0)
        if self.dir and (self.dir / "index.json").exists():
            self.index = json.loads((self.dir / "index.json").read_text(encoding="utf-8"))
            lib = self.dir / "library.json"
            self.groups = json.loads(lib.read_text(encoding="utf-8")).get("groups", []) if lib.exists() else []
            for it in self.index:
                if ID_RE.match(it["id"]):
                    self.files[it["id"]] = (self.dir, it.get("file") or it["id"])
        # 추가 자료 폴더(예: 외부 솔버 결과 묶음, 이 컴퓨터에만 있는 것). 같은 id는 기본 자료가 우선한다.
        self.external = 0
        for d in (Path(x) for x in extra_dirs):
            if not (d / "index.json").exists():
                continue
            lib = d / "library.json"
            for g in (json.loads(lib.read_text(encoding="utf-8")).get("groups", []) if lib.exists() else []):
                if all(g["id"] != x["id"] for x in self.groups):
                    self.groups.append(g)
            for it in json.loads((d / "index.json").read_text(encoding="utf-8")):
                if ID_RE.match(it["id"]) and it["id"] not in self.files and (d / "rec" / f"{it.get('file') or it['id']}.json").is_file():
                    self.index.append(it)
                    self.files[it["id"]] = (d, it.get("file") or it["id"])
                    self.external += it.get("source") == "external"
        self.meta = {**meta, "library": bool(self.files), "libraryEntries": len(self.files), "externalEntries": self.external}

    # ---- 응답 만들기 ----
    def _base_headers(self, origin: str | None, cache: str) -> dict[str, str]:
        h = {"Cache-Control": cache, "X-Content-Type-Options": "nosniff", "Vary": "Origin, Accept-Encoding"}
        if origin is not None and origin_allowed(origin, self.origins):
            h["Access-Control-Allow-Origin"] = origin
        return h

    def _json(self, obj, origin, cache, accept_gzip, key: str | None = None) -> Reply:
        if key and key in self._cache:
            raw, gz = self._cache[key]
        else:
            raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if not isinstance(obj, bytes) else obj
            gz = gzip.compress(raw, 6) if len(raw) > 1024 else b""
            if key:
                self._cache[key] = (raw, gz)
        h = self._base_headers(origin, cache)
        h["Content-Type"] = "application/json; charset=utf-8"
        body = raw
        if accept_gzip and gz:
            h["Content-Encoding"] = "gzip"
            body = gz
        h["Content-Length"] = str(len(body))
        return Reply(200, h, body)

    def _limited(self) -> bool:
        start, n = self._window
        now = self.clock()
        if now - start >= 1.0:
            self._window = (now, 1)
            return False
        self._window = (start, n + 1)
        return n + 1 > MAX_REQUESTS_PER_SECOND

    # ---- 경로 처리. API 경로가 아니면 None(WebSocket 핸드셰이크로 넘긴다) ----
    def route(self, method: str, target: str, headers) -> Reply | None:
        r = self._route(method, target, headers)
        if r is not None and method == "HEAD":
            r.body = b""  # 머리글(Content-Length 포함)만 돌려준다
        return r

    def _route(self, method: str, target: str, headers) -> Reply | None:
        path = urlsplit(target).path
        if path != "/healthz" and not path.startswith("/api/"):
            return None
        origin = headers.get("Origin")
        if method == "OPTIONS":
            h = self._base_headers(origin, "no-store")
            h["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
            h["Content-Length"] = "0"
            return Reply(204, h)
        if method not in ("GET", "HEAD"):
            return Reply(405, {"Allow": "GET, HEAD, OPTIONS", "Content-Length": "0"})
        if self._limited():
            return Reply(429, {"Retry-After": "1", "Content-Length": "0"})
        gz = "gzip" in (headers.get("Accept-Encoding") or "")
        if path == "/healthz":
            return self._json({"ok": True, "solver": self.meta.get("solver")}, origin, "no-store", False)
        if path == "/api/meta":
            return self._json(self.meta, origin, "no-store", False)
        if path == "/api/library":
            if not self.files:
                return Reply(503, {"Content-Length": "0"})
            obj = {"version": 1, "groups": self.groups, "index": self.index}
            return self._json(obj, origin, f"public, max-age={CACHE_SECONDS}", gz, key="library")
        m = re.fullmatch(r"/api/library/([a-z0-9_]{1,40})", path)
        if m and m.group(1) in self.files:
            folder, file = self.files[m.group(1)]
            key = f"rec:{folder}:{file}"
            if key not in self._cache:
                p = folder / "rec" / f"{file}.json"
                if not p.is_file():
                    return Reply(404, {"Content-Length": "0"})
                raw = p.read_bytes()
                self._cache[key] = (raw, gzip.compress(raw, 6))
            return self._json(None, origin, f"public, max-age={CACHE_SECONDS}", gz, key=key)
        return Reply(404, {"Content-Length": "0"})
