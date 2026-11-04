"""가상 홀 USD(`usd/scenes/hall01.usda`)에서 센서 앵커 위치를 뽑아 `server/data/anchors.json`로 저장한다.

외부 CFD 결과 변환 도구(`sim/external/`)가 USD 라이브러리(pxr) 없이 앵커 위치를 쓰게 하려고 만든 사본이다.
우리가 직접 만든 가상 홀의 좌표라서 저장소에 올려도 된다(실제 시설 좌표가 아니다).

    cd experiments/omniverse_probe
    uv run --python 3.13 python ../../scripts/export_anchors.py

단위는 cm, 좌표는 장면(USD)과 같다(Z가 위). 장면을 바꾸면 이 파일도 다시 만든다(시험이 같은지 확인한다).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments" / "omniverse_probe"))
import hall60_sim as hs  # noqa: E402


def build(scene: Path) -> dict:
    hall = hs.read_hall(scene)
    anchors = [{"equipment": a["equipment"].lower(), "metric": a["metric"], "unit": a["unit"], "pos_cm": [round(float(v), 3) for v in a["pos_cm"]]} for a in hall["anchors"]]
    anchors.sort(key=lambda a: (a["equipment"], a["metric"]))
    return {"version": 1, "unit": "cm", "size_cm": [float(v) for v in hall["size_cm"]], "scene": "usd/scenes/hall01.usda", "anchors": anchors}


def main() -> int:
    out = ROOT / "server" / "data" / "anchors.json"
    data = build(ROOT / "usd" / "scenes" / "hall01.usda")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{out.relative_to(ROOT)}: 앵커 {len(data['anchors'])}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
