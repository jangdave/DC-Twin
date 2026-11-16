"""보정 모델 입력(특징)을 보강하면 랙 제거 + 공조기 두 대 정지 조합이 나아지는지 본다(HAC, CAC). docs/34 6.2의 "C" 방법.

사용 (sim/thermal 폴더에서):
    uv run --python 3.13 python ../../experiments/surrogate_model/evaluate_feature_variants.py [--report 결과.md] [--quick]

배경(experiments/results/E8_remove_two_off_samples.md): 이 조합 샘플 18개를 더해도 보류 B와 HAC 보류 E가 나빠졌다. 지금 입력은 빈자리에 대해
"같은 줄 2칸 안의 제거 랙 수"와 "같은 냉기 통로의 제거 랙 수"만 안다. 빈자리가 어느 열기 통로에 있는지, 꺼진 공조기와 얼마나 가까운지는 모른다.

입력 조합(지금 입력 17개 뒤에 붙인다):
- 지금: 그대로
- 빈자리: 같은 줄에서 가장 가까운 빈자리까지 칸 수, 가장 가까운 빈자리까지 거리(m), 같은 열기 통로의 빈자리 수, 제거 여부
- 공조기: 가장 가까운 꺼진 공조기까지 거리(m), 가장 가까운 켜진 공조기까지 거리(m), 빈자리가 있는 열기 통로들의 공조기 가동 정도(가장 낮은 값)
- 둘 다: 빈자리 + 공조기 + (1 - 이 랙 열기 통로 가동 정도) x 같은 열기 통로 빈자리 수

보는 것(각 입력 조합마다 학습 68개 / 68 + 추가 18개):
1. 보류 사례 A, B, D, E의 보정 RMSE
2. 기존 학습 68개를 하나씩 빼고 학습한 평균 보정 RMSE(전체, remove_and_fail)
3. 추가 18개를 하나씩 빼고 학습한 평균 보정 RMSE
보류 사례를 보면서 입력을 고르면 보류 사례에 맞추게 되므로, 고르는 기준은 2·3(하나씩 빼고 본 오차)이고 보류 사례는 확인용이다.
저장된 모델과 dct_thermal 코드는 바꾸지 않는다(이 스크립트 안에서만 특징 함수를 바꿔 끼운다).
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
HALL = json.loads((rm.BASE / "layout.json").read_text(encoding="utf-8"))
RACK_C = {r["name"]: np.array([(r["min"][d] + r["max"][d]) / 200.0 for d in range(2)]) for r in HALL["racks"]}   # m
CRAC_C = {c["name"]: np.array([(c["min"][d] + c["max"][d]) / 200.0 for d in range(2)]) for c in HALL["cracs"]}
ORIG = rm.sample_features
VARIANT = "지금"
VARIANTS = ["지금", "빈자리", "공조기", "둘 다"]
FAR = 30.0  # 해당하는 것이 없을 때 쓰는 먼 거리(m), 칸 수는 10
OUT: list[str] = []


def p(line: str = "") -> None:
    OUT.append(line)
    print(line, flush=True)


def extra_features(geo, sample, names):
    removed = sample.get("remove", [])
    fan = [sample["fan"][f"CRAC_{i + 1:02d}"] for i in range(8)]
    aisle_of = rm.crac_aisle(geo.n_hot)
    aisle_fan = np.zeros(geo.n_hot)
    for i, a in enumerate(aisle_of):
        aisle_fan[a] += fan[i] / 2.0
    idx = {n: i for i, n in enumerate(geo.names)}
    rem_hot = [geo.hot_aisle[idx[m]] for m in removed]
    rem_aisle_fan = min((aisle_fan[a] for a in rem_hot), default=1.0)
    off = [f"CRAC_{i + 1:02d}" for i in range(8) if fan[i] == 0.0]
    on = [f"CRAC_{i + 1:02d}" for i in range(8) if fan[i] > 0.0]
    rows = []
    for n in names:
        i, c = idx[n], RACK_C[n]
        same_row = [abs(int(m[-2:]) - int(n[-2:])) for m in removed if geo.row[idx[m]] == geo.row[i]]  # 같은 줄은 랙 번호가 이어진다
        slot = float(min(same_row, default=10))
        dist_rm = float(min((np.linalg.norm(RACK_C[m] - c) for m in removed), default=FAR))
        hot_rm = float(sum(1 for a in rem_hot if a == geo.hot_aisle[i]))
        d_off = float(min((np.linalg.norm(CRAC_C[k] - c) for k in off), default=FAR))
        d_on = float(min((np.linalg.norm(CRAC_C[k] - c) for k in on), default=FAR))
        f_rm = [slot, dist_rm, hot_rm, 1.0 if removed else 0.0]
        f_cr = [d_off, d_on, rem_aisle_fan]
        if VARIANT == "빈자리":
            rows.append(f_rm)
        elif VARIANT == "공조기":
            rows.append(f_cr)
        else:
            rows.append(f_rm + f_cr + [(1.0 - aisle_fan[geo.hot_aisle[i]]) * hot_rm])
    return np.array(rows, dtype=float)


def patched(geo, sample, ours, ours_info):
    X, o, names = ORIG(geo, sample, ours, ours_info)
    if VARIANT == "지금":
        return X, o, names
    return np.hstack([X, extra_features(geo, sample, names)]), o, names


rm.sample_features = patched  # predictor.predict도 rm.sample_features를 부르므로 같이 바뀐다


def rmse_of(model, d, info):
    r = model.predict(specs[d["id"]], dict(zip(d["names"], d["ours"])), info[d["id"]], enforce_range=False)
    return rm.rmse(d["of"], np.array([r.corrected[n] for n in d["names"]]))


def fit(data):
    return pr.ResidualPredictor().fit(data, specs)


def main() -> None:
    global VARIANT
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, default=None)
    ap.add_argument("--quick", action="store_true", help="하나씩 빼는 검증을 건너뛴다(보류 사례만)")
    args = ap.parse_args()
    for scene, d0, d4, d5 in (("HAC (기본 장면)", rm.DATA, rm.RES / "surrogate_rf_v4", rm.RES / "surrogate_rf_v5"),
                              ("CAC", rm.DATA_CAC, rm.RES / "surrogate_cac_v4", rm.RES / "surrogate_cac_v5")):
        info = {}
        for d in (d0, d4, d5):
            info.update(json.loads((d / "ours_progress.json").read_text(encoding="utf-8")))
        p(f"\n## {scene}\n")
        p("| 입력 | 학습 | 보류 A | 보류 B | 보류 D | 보류 E | 68개 하나씩 빼고 | 그중 remove_and_fail | 추가 18개 하나씩 빼고 |")
        p("|---|---|---|---|---|---|---|---|---|")
        for VARIANT in VARIANTS:
            base = rm.load_dataset(d0, SPEC0)
            extra = rm.load_dataset(d4, SPEC4) + rm.load_dataset(d5, SPEC5)
            train = [d for d in base if not d["holdout"]]
            hold = {d["id"].split("_")[1]: d for d in base if d["holdout"]}
            rem = np.array([d["group"] == "remove_and_fail" for d in train])
            for tag, add in (("68개", []), ("68 + 18개", extra)):
                m = fit(train + add)
                h = [rmse_of(m, hold[k], info) for k in "ABDE"]
                if args.quick:
                    loo, loo_x = np.array([np.nan]), [np.nan]
                    rem_ = np.array([True])
                else:
                    loo = np.array([rmse_of(fit([x for x in train if x["id"] != d["id"]] + add), d, info) for d in train])
                    rem_ = rem
                    # 추가 샘플: 68개만이면 기존 68개로, 68 + 18이면 나머지 17개를 더해 학습
                    loo_x = [rmse_of(fit(train + [x for x in add if x["id"] != d["id"]]) if add else m, d, info) for d in extra]
                p(f"| {VARIANT} | {tag} | " + " | ".join(f"{v:.2f}" for v in h)
                  + f" | {np.mean(loo):.3f} | {np.mean(loo[rem_]):.3f} | {np.mean(loo_x):.2f} |")
    if args.report:
        args.report.write_text("\n".join(OUT) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
