"""학습 샘플 전체로 예측기를 학습해 model.pkl로 저장한다(저장소에는 올리지 않는다, 몇 초 걸린다).

사용 (이 폴더에서):
    uv run --python 3.13 python train_predictor.py [--only-converged] [--out model.pkl]
    CAC 장면용(docs/34 6장): ... train_predictor.py --data-dir ../openfoam_baseline/results/surrogate_cac --out model_cac.pkl
센서 생성기(L2)가 `ResidualPredictor.load("model.pkl")`로 읽어서 `predict(...)`를 부른다.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import platform
import subprocess
from pathlib import Path

import numpy as np
import sklearn

import predictor as pr
import residual_model as rm

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--only-converged", action="store_true", help="수렴한 샘플만 학습에 쓴다(기본은 미수렴 9개 포함)")
ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "model.pkl")
ap.add_argument("--data-dir", type=Path, default=rm.DATA, help="OpenFOAM 결과 폴더(기본 HAC surrogate_rf, CAC는 surrogate_cac)")
a = ap.parse_args()
DATA = a.data_dir.resolve()
samples_json = rm.BASE / "surrogate" / "samples.json"
specs = {s["id"]: s for s in json.loads(samples_json.read_text(encoding="utf-8"))["samples"]}
data = [d for d in rm.load_dataset(DATA, samples_json, a.only_converged) if not d["holdout"]]
p = pr.ResidualPredictor().fit(data, specs)
p.save(a.out)
print(f"학습 샘플 {len(data)}개로 학습, 저장: {a.out} ({a.out.stat().st_size / 1e6:.1f} MB)")
print(f"학습 범위: 줄 전력 {p.power_range[0]:g}~{p.power_range[1]:g} kW, 제거한 랙 최대 {p.max_removed}기")


# ---- 학습 이력: model.pkl은 저장소에 올리지 않으므로, 어떤 데이터와 코드로 만들었는지 작은 JSON으로 남긴다(저장소에 올린다) ----
def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(HERE), *args], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


used = {d["id"] for d in data}
progress = json.loads((DATA / "progress.json").read_text(encoding="utf-8"))
excluded = {sid: ("보류(학습에서 제외)" if specs[sid].get("holdout") else progress.get(sid, {}).get("status", "결과 파일 없음")) for sid in specs if sid not in used}
# dirty: 학습에 쓴 코드와 데이터가 커밋과 다르면 True
meta = {
    "version": 1,
    "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "model_sha256": sha256(a.out),
    "samples_json_sha256": sha256(samples_json),
    "data_dir": DATA.name,
    "code": {"git_commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--untracked-files=no", "--", ":(top)experiments/surrogate_model", ":(top)experiments/openfoam_baseline/surrogate/samples.json", ":(top)experiments/openfoam_baseline/results/" + DATA.name)), "python": platform.python_version(), "scikit_learn": sklearn.__version__, "numpy": np.__version__},
    "only_converged": a.only_converged,
    "n_samples": len(data),
    "sample_ids": sorted(used),
    "status_counts": {k: sum(1 for d in data if d["status"] == k) for k in sorted({d["status"] for d in data})},
    "excluded": excluded,
    "power_range_kw": list(p.power_range),
    "max_removed_racks": p.max_removed,
    "hyper": {"n_estimators": p.n_estimators, "min_samples_leaf": p.min_samples_leaf, "seed": p.seed},
    "note": "모델 파일(model.pkl)은 gitignore다. 이 파일로 어떤 데이터와 코드로 만들었는지 확인한다. 같은 데이터, 코드, 시드면 예측은 같다(확인: 두 번 학습한 모델의 예측 차이 2e-15). 파일 바이트(model_sha256)는 실행마다 달라질 수 있으니(내부 집합 순서) 같은 모델인지는 samples_json_sha256과 예측으로 본다.",
}
meta_path = a.out.with_suffix(".meta.json")
meta_path.write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"학습 이력 저장: {meta_path.name} (샘플 {meta['n_samples']}개, 제외 {len(excluded)}개)")
