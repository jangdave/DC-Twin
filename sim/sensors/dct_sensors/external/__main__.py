"""외부 CFD 결과(VTK) 변환 도구.

    python -m dct_sensors.external inspect <파일.vtk>
    python -m dct_sensors.external build --vtk <파일.vtk> --mapping <mapping.json> --id ext_case1 --title "이름" [--note "설명"] [--out <폴더>]
    python -m dct_sensors.external demo                    # 합성 시험 데이터로 전체 흐름을 한 번 돌려 본다(실제 계산 결과가 아니다)

만든 묶음은 서버에 `--extra-data-dir <폴더>`로 알려 주면 웹 화면의 시뮬레이션 메뉴 "외부 솔버 결과 (로컬 전용)"에 나온다.
기본 출력 폴더는 `sim/out/local_only/external_pack/`(gitignore). 저장소에 올라갈 수 있는 위치는 거절한다. 설명은 `server/README.md`의 "외부 솔버 결과".
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from . import vtk_legacy, writer
from .mapping import Mapping, MappingError
from .pack import DEFAULT_PACK, REPO, PackError, build_case, write_pack

WEB_DATA = REPO / "web" / "viewer" / "public" / "data"
SERVER_DATA = REPO / "server" / "data"


def _load_inputs(args):
    sensors = json.loads(Path(args.sensors or WEB_DATA / "sensors.json").read_text(encoding="utf-8"))
    anchors = json.loads(Path(args.anchors or SERVER_DATA / "anchors.json").read_text(encoding="utf-8"))
    baseline = json.loads(Path(args.baseline or WEB_DATA / "rec" / "normal.json").read_text(encoding="utf-8"))
    return sensors, anchors, baseline


def cmd_inspect(args) -> int:
    print(vtk_legacy.describe(vtk_legacy.read(args.file)))
    return 0


def cmd_build(args) -> int:
    mapping = Mapping.load(args.mapping)
    sensors, anchors, baseline = _load_inputs(args)
    rec, entry = build_case(args.vtk, mapping, sensors, anchors, baseline, args.id, args.title, args.note or "")
    out = write_pack(Path(args.out) if args.out else DEFAULT_PACK, rec, entry)
    cov = rec["meta"]["coverage"]
    print(f"[외부 결과] {entry['id']} -> {out}")
    print(f"  앵커 {cov['anchors']}개, 가장 먼 앵커까지 {cov['maxDistanceCm']} cm, 평균 {cov['meanDistanceCm']} cm")
    print(f"  채운 센서(CFD가 아닌 값): {rec['meta']['filled']}")
    print(f"  알람 {len(rec['alarms'])}건")
    print(f"  서버: --extra-data-dir {out}")
    return 0


def synthetic_demo_vtk(path: Path) -> None:
    """우리 홀 크기의 상자에 온도를 합성한다(복도 앞쪽이 차갑고 뒤쪽이 따뜻한 단순한 함수). 실제 계산 결과가 아니다."""
    hall = json.loads((SERVER_DATA / "anchors.json").read_text(encoding="utf-8"))["size_cm"]
    spacing = 20.0  # cm
    dims = tuple(int(np.ceil(s / spacing)) + 1 for s in hall)
    xs, ys, zs = (np.arange(d) * spacing for d in dims)
    gz, gy, gx = np.meshgrid(zs, ys, xs, indexing="ij")
    t = 18.0 + 4.0 * (gz / hall[2]) + 3.0 * np.exp(-(((gx - hall[0] / 2) / 250.0) ** 2 + ((gy - hall[1] / 2) / 300.0) ** 2))
    path.write_bytes(writer.structured_points(dims, (0.0, 0.0, 0.0), (spacing / 100,) * 3, {"T": t.ravel()}, binary=True, title="DC-Twin 합성 시험 데이터(실제 계산 결과가 아님)"))


def cmd_demo(args) -> int:
    out = Path(args.out) if args.out else DEFAULT_PACK.parent / "external_demo"
    sensors, anchors, baseline = _load_inputs(args)
    out.mkdir(parents=True, exist_ok=True)
    from .pack import ensure_ignored

    ensure_ignored(out)
    vtk = out / "demo.vtk"
    synthetic_demo_vtk(vtk)
    mapping = Mapping.from_dict({"tool": "합성 시험 데이터", "unit": "m", "temperature_unit": "C", "max_distance_cm": 30, "case": {"rack_power_kw": 8.0, "supply_temp": 18.0}})
    rec, entry = build_case(vtk, mapping, sensors, anchors, baseline, "ext_demo", "합성 시험 데이터", "파이프라인 확인용으로 만든 합성 온도장이다. 실제 계산 결과가 아니다.")
    write_pack(out, rec, entry)
    print(f"[데모] {out}에 묶음을 만들었다. 서버를 --extra-data-dir {out} 로 띄우면 시뮬레이션 메뉴의 \"외부 솔버 결과 (로컬 전용)\"에 보인다(합성 시험 데이터).")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dct_sensors.external", description="외부 CFD 결과(VTK) 변환")
    ap.add_argument("--sensors", default=None, help="센서 목록(기본: web/viewer/public/data/sensors.json)")
    ap.add_argument("--anchors", default=None, help="앵커 위치(기본: server/data/anchors.json)")
    ap.add_argument("--baseline", default=None, help="비는 센서를 채울 기준 녹화(기본: 정상 가동)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("inspect", help="VTK 파일의 구조를 본다")
    p.add_argument("file")
    p.set_defaults(fn=cmd_inspect)
    p = sub.add_parser("build", help="VTK를 자료 묶음으로 바꾼다")
    p.add_argument("--vtk", required=True)
    p.add_argument("--mapping", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--note", default="")
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser("demo", help="합성 시험 데이터로 전체 흐름을 돌려 본다")
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_demo)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (vtk_legacy.VtkError, MappingError, PackError, FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[오류] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
