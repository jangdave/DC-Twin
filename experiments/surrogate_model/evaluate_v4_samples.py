"""4차 샘플(랙 제거 + 같은 통로 2대 고장 6개, samples_v4.json)을 학습에 더하면 보류 사례가 좋아지는지 본다(HAC, CAC).

사용 (sim/thermal 폴더에서):
    uv run --python 3.13 python ../../experiments/surrogate_model/evaluate_v4_samples.py [--report 결과.md]
결과는 experiments/results/E8_remove_two_off_samples.md에 옮겨 적었다. 저장된 모델(model.pkl, model_cac.pkl)은 바꾸지 않는다.
"""
import argparse, json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sim" / "thermal"))
from dct_thermal import residual_model as rm, predictor as pr

SUR = rm.BASE / "surrogate"
spec0, spec4 = SUR / "samples.json", SUR / "samples_v4.json"
specs = {s["id"]: s for f in (spec0, spec4) for s in json.loads(f.read_text(encoding="utf-8"))["samples"]}
OUT = []
ap = argparse.ArgumentParser(); ap.add_argument("--report", type=Path, default=None); args = ap.parse_args()

def p(*a):
    OUT.append(" ".join(str(x) for x in a)); print(*a, flush=True)

def stats(model, d, info):
    ours = dict(zip(d["names"], d["ours"]))
    r = model.predict(specs[d["id"]], ours, info, enforce_range=False)
    c = np.array([r.corrected[n] for n in d["names"]]); err = d["of"] - c
    inside = np.mean([r.lower90[n] <= t <= r.upper90[n] for n, t in zip(d["names"], d["of"])])
    lv = np.array([r.level[n] for n in d["names"]]); big = np.abs(err) > 2
    return rm.rmse(d["of"], d["ours"]), rm.rmse(d["of"], c), float(np.abs(err).max()), int(big.sum()), "/".join(str(int((lv[big] == k).sum())) for k in ("ok", "caution", "low")), float(inside)

for name, d0, d4 in (("HAC", rm.DATA, rm.RES / "surrogate_rf_v4"), ("CAC", rm.DATA_CAC, rm.RES / "surrogate_cac_v4")):
    base = rm.load_dataset(d0, spec0); new = rm.load_dataset(d4, spec4)
    info = {**json.loads((d0 / "ours_progress.json").read_text(encoding="utf-8")), **json.loads((d4 / "ours_progress.json").read_text(encoding="utf-8"))}
    prog4 = json.loads((d4 / "progress.json").read_text(encoding="utf-8"))
    train = [d for d in base if not d["holdout"]]; hold = [d for d in base if d["holdout"]]
    m0 = pr.ResidualPredictor().fit(train, specs); m1 = pr.ResidualPredictor().fit(train + new, specs)
    p(f"\n## {name}: 학습 {len(train)}개 / +4차 {len(new)}개")
    p("4차 샘플 상태:", {k: (v["status"], v.get("iterations")) for k, v in prog4.items()})
    p("\n| 사례 | 모델 | 우리 RMSE | 보정 RMSE | 최대 오차 | 2도 넘는 랙 | 그 랙 등급 ok/caution/low | 구간 안 |")
    p("|---|---|---|---|---|---|---|---|")
    for d in hold:
        for tag, m in (("기존", m0), ("+4차", m1)):
            a = stats(m, d, info[d["id"]])
            p(f"| {d['id']} | {tag} | {a[0]:.2f} | {a[1]:.2f} | {a[2]:.2f} | {a[3]} | {a[4]} | {a[5]:.2f} |")
    p("\n4차 샘플을 기존 모델로(처음 보는 사례로) 예측:")
    p("| 샘플 | 우리 RMSE | 보정 RMSE | 최대 오차 | 2도 넘는 랙 | 등급 | 구간 안 |")
    p("|---|---|---|---|---|---|---|")
    for d in new:
        a = stats(m0, d, info[d["id"]])
        p(f"| {d['id']} | {a[0]:.2f} | {a[1]:.2f} | {a[2]:.2f} | {a[3]} | {a[4]} | {a[5]:.2f} |")
    # 4차 샘플 하나씩 빼고(나머지 4차 5개 + 기존 학습) 예측
    p("\n4차 샘플 하나씩 빼고 학습한 예측(보정 RMSE): " + ", ".join(
        f"{d['id'][:3]} {stats(pr.ResidualPredictor().fit(train + [x for x in new if x['id'] != d['id']], specs), d, info[d['id']])[1]:.2f}" for d in new))

if args.report:
    args.report.write_text("\n".join(OUT) + "\n", encoding="utf-8")
