"""장면 형상 사본이 장면 USD와 맞는지 확인한다(docs/30 M11).

장면(`usd/scenes/hall01.usda`)은 설정에서만 만들고, 여러 곳이 그 사본을 쓴다. 랙을 옮기고 사본 하나를 빠뜨리면
보정 모델, 웹, 서버가 조용히 다른 형상을 쓰게 되므로, 장면에서 다시 뽑은 값과 사본을 비교한다.

| 사본 | 누가 쓰나 | 비교 |
|---|---|---|
| `experiments/openfoam_baseline/layout.json` | 보정 모델 형상(`residual_model.load_geometry`), OpenFOAM 사례 생성, 웹 자료 생성 | 장면에서 다시 읽은 값과 같음 |
| `server/data/anchors.json` | 외부 결과 변환(pxr 없이) | `export_anchors.build`와 같음 |
| `server/data/sensor_manifest.json` | 서버 이미지 | `build_manifest`와 같음 |
| `sim/out/sensor_manifest.json`(있으면, gitignore) | 생성기, 서버 실행 | `build_manifest`와 같음 |
| `web/viewer/public/data/scene.json` | 웹 화면 | 랙, CRAC 이름과 상자가 layout.json과 같음 |
| `web/viewer/public/data/sensors.json` | 웹 화면 | 센서 ID 목록과 기준값이 매니페스트와 같음 |

사용 (experiments/omniverse_probe 폴더에서, usd-core가 있는 환경):
    uv run --python 3.13 python ../../scripts/check_geometry.py
다른 것이 있으면 무엇이 다른지 적고 종료 코드 1. 고치는 방법은 각 사본을 만드는 명령을 다시 실행하는 것이다(메시지에 적는다).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sim" / "thermal"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "usd_tools"))

SCENE = ROOT / "usd" / "scenes" / "hall01.usda"
LAYOUT = ROOT / "experiments" / "openfoam_baseline" / "layout.json"
ANCHORS = ROOT / "server" / "data" / "anchors.json"
MANIFESTS = [ROOT / "server" / "data" / "sensor_manifest.json", ROOT / "sim" / "out" / "sensor_manifest.json"]
WEB = ROOT / "web" / "viewer" / "public" / "data"
THRESH_KEYS = ("range", "warn", "critical", "direction", "unit", "metric", "equipmentType")


def _norm(x):
    """JSON으로 한 번 오간 값(튜플 -> 리스트, numpy 수 -> float)으로 맞춘다."""
    return json.loads(json.dumps(x, default=float))


def _close(a, b, tol=1e-6) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tol
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_close(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_close(a[k], b[k], tol) for k in a)
    return a == b


def _first_diff(a, b, path="") -> str:
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{path}/{k}: 한쪽에만 있음"
            if not _close(a[k], b[k]):
                return _first_diff(a[k], b[k], f"{path}/{k}")
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: 길이 {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            if not _close(x, y):
                return _first_diff(x, y, f"{path}[{i}]")
    return f"{path}: {json.dumps(a, ensure_ascii=False)[:80]} != {json.dumps(b, ensure_ascii=False)[:80]}"


def check() -> list[str]:
    """다른 점을 문장 목록으로 돌려준다(빈 목록이면 모두 맞음)."""
    from pxr import Usd

    import build_manifest as bm
    import export_anchors as ea
    from dct_thermal import hall60_sim as hs

    problems: list[str] = []

    hall = _norm(hs.read_hall(SCENE))
    layout = json.loads(LAYOUT.read_text(encoding="utf-8"))
    if not _close(hall, layout):
        problems.append(f"layout.json이 장면과 다르다({_first_diff(hall, layout)}). 다시 만들기: "
                        "cd experiments/omniverse_probe && uv run --python 3.13 python ../openfoam_baseline/export_layout.py")

    anchors = ea.build(SCENE)
    if not _close(_norm(anchors), json.loads(ANCHORS.read_text(encoding="utf-8"))):
        problems.append(f"server/data/anchors.json이 장면과 다르다({_first_diff(_norm(anchors), json.loads(ANCHORS.read_text(encoding='utf-8')))}). "
                        "다시 만들기: cd experiments/omniverse_probe && uv run --python 3.13 python ../../scripts/export_anchors.py")

    manifest = bm.build_manifest(Usd.Stage.Open(str(SCENE)))
    for m in MANIFESTS:
        if not m.exists():
            continue  # sim/out은 gitignore: 깨끗한 복제본에는 없다
        if json.loads(m.read_text(encoding="utf-8")) != manifest:
            rel = m.relative_to(ROOT).as_posix()
            problems.append(f"{rel}가 장면과 다르다({_first_diff(manifest, json.loads(m.read_text(encoding='utf-8')))}). 다시 만들기: "
                            f"cd scripts/usd_tools && uv run --python 3.13 python build_manifest.py ../../usd/scenes/hall01.usda ../../{rel}")

    scene = json.loads((WEB / "scene.json").read_text(encoding="utf-8"))
    for kind in ("racks", "cracs"):
        want = {d["name"]: (d["min"], d["max"]) for d in layout[kind]}
        got = {d["name"]: (d["min"], d["max"]) for d in scene[kind]}
        if want.keys() != got.keys():
            problems.append(f"웹 scene.json의 {kind} 이름이 layout.json과 다르다(없는 것 {sorted(want.keys() - got.keys())[:3]}, 남는 것 {sorted(got.keys() - want.keys())[:3]})")
        else:
            bad = [n for n in want if not _close([list(map(float, want[n][0])), list(map(float, want[n][1]))], [list(map(float, got[n][0])), list(map(float, got[n][1]))], 1e-3)]
            if bad:
                problems.append(f"웹 scene.json의 {kind} 위치가 layout.json과 다르다: {bad[:3]}. 다시 만들기: cd web/viewer && npm run data")

    web_sensors = json.loads((WEB / "sensors.json").read_text(encoding="utf-8"))
    pick = lambda s: {k: s.get(k, "high" if k == "direction" else None) for k in THRESH_KEYS}  # 방향이 없으면 high(매니페스트 규칙, 웹 자료는 채워 둔다)
    want = {s["sensorId"]: pick(s) for s in manifest["sensors"]}
    got = {s["sensorId"]: pick(s) for s in web_sensors}
    if want != got:
        miss, extra = sorted(want.keys() - got.keys()), sorted(got.keys() - want.keys())
        diff = [k for k in want.keys() & got.keys() if want[k] != got[k]]
        problems.append(f"웹 sensors.json이 매니페스트와 다르다(없는 것 {miss[:3]}, 남는 것 {extra[:3]}, 기준값 다름 {diff[:3]}). 다시 만들기: cd web/viewer && npm run data")
    return problems


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    problems = check()
    for p in problems:
        print("다름 ", p)
    print("형상 사본이 모두 장면과 같다" if not problems else f"\n다른 사본 {len(problems)}개")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
