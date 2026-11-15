"""추가 샘플(4차 samples_v4.json 6개, 5차 samples_v5.json 12개: 랙 제거 + 공조기 2대 고장)을 학습에 더하면 좋아지는지 본다(HAC, CAC).

사용 (sim/thermal 폴더에서):
    uv run --python 3.13 python ../../experiments/surrogate_model/evaluate_extra_samples.py [--report 결과.md]

비교하는 모델(모두 ResidualPredictor 기본 설정, 같은 시드):
- 기존: samples.json 학습 68개(지금 저장된 model.pkl, model_cac.pkl과 같은 데이터)
- +4차: 기존 + 4차 6개
- +4·5차: 기존 + 4차 + 5차 18개
보는 것:
1. 보류 사례 A, B, D, E(학습에 없는 사례)
2. 기존 학습 68개를 하나씩 빼고 학습한 오차(추가 샘플이 원래 잘 맞던 곳을 망치는지)
3. 추가 샘플 18개를 하나씩 빼고 학습한 오차(이 조합을 얼마나 배우는지). 기존 모델의 예측과 비교
결과는 experiments/results/E8_remove_two_off_samples.md에 옮겨 적었다. 저장된 모델은 바꾸지 않는다.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sim" / "thermal"))
from dct_thermal import predictor as pr  # noqa: E402
from dct_thermal import residual_model as rm  # noqa: E402

SUR = rm.BASE / "surrogate"
SPEC0, SPEC4, SPEC5 = SUR / "samples.json", SUR / "samples_v4.json", SUR / "samples_v5.json"
specs = {s["id"]: s for f in (SPEC0, SPEC4, SPEC5) for s in json.loads(f.read_text(encoding="utf-8"))["samples"]}
OUT: list[str] = []


def p(line: str = "") -> None:
    OUT.append(line)
    print(line, flush=True)


def stats(model, d, info):
    ours = dict(zip(d["names"], d["ours"]))
    r = model.predict(specs[d["id"]], ours, info[d["id"]], enforce_range=False)
    c = np.array([r.corrected[n] for n in d["names"]])
    err = d["of"] - c
    inside = float(np.mean([r.lower90[n] <= t <= r.upper90[n] for n, t in zip(d["names"], d["of"])]))
    lv = np.array([r.level[n] for n in d["names"]])
    big = np.abs(err) > 2
    return {"ours": rm.rmse(d["of"], d["ours"]), "rmse": rm.rmse(d["of"], c), "max": float(np.abs(err).max()), "big": int(big.sum()),
            "lv": "/".join(str(int((lv[big] == k).sum())) for k in ("ok", "caution", "low")), "inside": inside}


def fit(data):
    return pr.ResidualPredictor().fit(data, specs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()
    for name, d0, d4, d5 in (("HAC (기본 장면)", rm.DATA, rm.RES / "surrogate_rf_v4", rm.RES / "surrogate_rf_v5"),
                             ("CAC", rm.DATA_CAC, rm.RES / "surrogate_cac_v4", rm.RES / "surrogate_cac_v5")):
        base = rm.load_dataset(d0, SPEC0)
        v4, v5 = rm.load_dataset(d4, SPEC4), rm.load_dataset(d5, SPEC5)
        info = {}
        for d in (d0, d4, d5):
            info.update(json.loads((d / "ours_progress.json").read_text(encoding="utf-8")))
        train = [d for d in base if not d["holdout"]]
        hold = [d for d in base if d["holdout"]]
        extra = v4 + v5
        models = {"기존": fit(train), "+4차": fit(train + v4), "+4·5차": fit(train + extra)}
        p(f"\n## {name}: 학습 {len(train)}개, 4차 {len(v4)}개, 5차 {len(v5)}개")
        for dd, tag in ((d4, "4차"), (d5, "5차")):
            pp = dd / "progress.json"
            prog = json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else {}
            nc = [k for k, v in prog.items() if v["status"] == "not_converged"]
            done = [k for k, v in prog.items() if v["status"] == "done"]
            p(f"- {tag} 수렴 {len(done)}개, 반복 한도 {', '.join(k[:3] for k in nc) or '없음'}")
        p("\n### 보류 사례\n")
        p("| 사례 | 모델 | 우리 RMSE | 보정 RMSE | 최대 오차 | 2도 넘는 랙 | 그 랙 등급 ok/caution/low | 구간 안 |")
        p("|---|---|---|---|---|---|---|---|")
        for d in hold:
            for tag, m in models.items():
                a = stats(m, d, info)
                p(f"| {d['id']} | {tag} | {a['ours']:.2f} | {a['rmse']:.2f} | {a['max']:.2f} | {a['big']} | {a['lv']} | {a['inside']:.2f} |")

        # 2. 기존 학습 샘플을 하나씩 빼고: 기존만 / 기존 + 추가 18개
        loo0, loo1 = [], []
        for d in train:
            rest = [x for x in train if x["id"] != d["id"]]
            loo0.append(stats(fit(rest), d, info)["rmse"])
            loo1.append(stats(fit(rest + extra), d, info)["rmse"])
        loo0, loo1 = np.array(loo0), np.array(loo1)
        rem = np.array([d["group"] == "remove_and_fail" for d in train])
        p("\n### 기존 학습 샘플을 하나씩 빼고 학습(샘플별 보정 RMSE 평균, 도)\n")
        p(f"| 대상 | 기존만 | 기존 + 추가 {len(extra)}개 | 나빠진 샘플(0.05도 넘게) |")
        p("|---|---|---|---|")
        p(f"| 68개 전체 | {loo0.mean():.3f} | {loo1.mean():.3f} | {int((loo1 - loo0 > 0.05).sum())} |")
        p(f"| remove_and_fail 12개 | {loo0[rem].mean():.3f} | {loo1[rem].mean():.3f} | {int((loo1[rem] - loo0[rem] > 0.05).sum())} |")
        worst = sorted(zip(loo1 - loo0, [d["id"] for d in train]), reverse=True)[:3]
        p("- 가장 나빠진 샘플: " + ", ".join(f"{sid} {dv:+.2f}" for dv, sid in worst))

        # 3. 추가 샘플을 하나씩 빼고(기존 + 나머지 17개) / 기존 모델로
        p(f"\n### 추가 샘플 {len(extra)}개를 하나씩 빼고 학습(보정 RMSE, 도)\n")
        p(f"| 샘플 | 우리 RMSE | 기존 모델 | 기존 + 나머지 {len(extra) - 1}개 | 최대 오차(기존 → 추가) | 구간 안(기존 → 추가) |")
        p("|---|---|---|---|---|---|")
        r0s, r1s = [], []
        for d in extra:
            a0 = stats(models["기존"], d, info)
            a1 = stats(fit(train + [x for x in extra if x["id"] != d["id"]]), d, info)
            r0s.append(a0["rmse"]); r1s.append(a1["rmse"])
            p(f"| {d['id']} | {a0['ours']:.2f} | {a0['rmse']:.2f} | {a1['rmse']:.2f} | {a0['max']:.2f} → {a1['max']:.2f} | {a0['inside']:.2f} → {a1['inside']:.2f} |")
        p(f"| 평균 | | {np.mean(r0s):.2f} | {np.mean(r1s):.2f} | | |")
    if args.report:
        args.report.write_text("\n".join(OUT) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
