"""샘플 명세(samples.json)에서 OpenFOAM 사례 정의를 만든다(보류 샘플은 건너뜀). cases/<id>/ 에 저장한다(작은 텍스트).

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/make_cases.py --out-dir ../openfoam_baseline/surrogate/cases_rf [--scene 장면.usda] [--spec 경로] [--only id ...] [--iters 3500]
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import gen_case  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--spec", type=Path, default=HERE / "samples.json")
ap.add_argument("--only", nargs="*", default=None)
ap.add_argument("--iters", type=int, default=3500)
ap.add_argument("--out-dir", type=Path, required=True, help="사례 정의를 둘 폴더(필수: 이중 바닥 전 cases, 기본 장면 cases_rf, CAC cases_cac)")
ap.add_argument("--scene", type=Path, default=None, help="장면 USD(기본 hall01.usda)")
a = ap.parse_args()
data = json.loads(a.spec.read_text(encoding="utf-8"))
samples = data["samples"] if isinstance(data, dict) else data
for s in samples:
    if s.get("holdout") or (a.only and s["id"] not in a.only):
        continue
    sys.argv = ["gen_case.py", "--spec", str(a.spec), "--sample", s["id"], "--iters", str(a.iters), "--conservative", "--out", str(a.out_dir / s["id"])] + (["--scene", str(a.scene)] if a.scene else [])
    gen_case.main()
