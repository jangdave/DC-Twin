"""두 센서 녹화(.jsonl)를 줄 단위로 비교한다. 샘플 값, 알람 전이, 집계가 같은지 본다.

    uv run python kit/compare_kit_run.py <기준.jsonl> <비교.jsonl> [허용 오차(기본 1e-6)]
종류(type), 시각(ts), 센서 ID가 줄마다 같아야 하고, 숫자 값은 허용 오차 안이어야 한다. 가장 큰 차이와 위치를 보인다.
"""
from __future__ import annotations

import json
import sys


def rows(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


def main() -> int:
    a, b = rows(sys.argv[1]), rows(sys.argv[2])
    tol = float(sys.argv[3]) if len(sys.argv) > 3 else 1e-6
    print(f"줄 수: {len(a)} / {len(b)}")
    if len(a) != len(b):
        print("실패: 줄 수가 다르다")
        return 1
    worst, where, bad_struct, kinds = 0.0, None, 0, {}
    for i, (x, y) in enumerate(zip(a, b)):
        if x.get("type") != y.get("type") or x.get("ts") != y.get("ts") or x.get("sensorId") != y.get("sensorId") or x.get("name") != y.get("name"):
            bad_struct += 1
            continue
        for k, v in x.items():
            w = y.get(k)
            if isinstance(v, (int, float)) and isinstance(w, (int, float)) and not isinstance(v, bool):
                d = abs(v - w)
                kinds[x["type"]] = max(kinds.get(x["type"], 0.0), d)
                if d > worst:
                    worst, where = d, (i, x.get("type"), x.get("sensorId") or x.get("name"), k, v, w)
            elif k not in ("seq",) and v != w and not isinstance(v, (int, float)):
                bad_struct += 1
    print(f"구조(종류, 시각, 센서 ID, 문자열 값)가 다른 줄: {bad_struct}")
    print("종류별 최대 차이:", {k: round(v, 9) for k, v in kinds.items()})
    print(f"최대 차이: {worst:.3g} 위치: {where}")
    ok = bad_struct == 0 and worst <= tol
    print("통과" if ok else "실패", f"(허용 오차 {tol})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
