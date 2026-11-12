"""불확실성과 안전장치 검증: 같은 고장 패턴(거울상 포함)을 통째로 빼고 학습한 예측기로 구간 포함 비율, 신뢰 등급별 오차, 새로움, 되돌림 규칙을 확인한다.

사용 (이 폴더에서):
    uv run --python 3.13 python evaluate_predictor.py [--only-converged] [--report 결과.md]
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

import predictor as pr
import residual_model as rm


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-converged", action="store_true")
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    samples_json = rm.BASE / "surrogate" / "samples.json"
    specs = {s["id"]: s for s in json.loads(samples_json.read_text(encoding="utf-8"))["samples"]}
    ours_info = json.loads((rm.DATA / "ours_progress.json").read_text(encoding="utf-8"))
    data = rm.load_dataset(rm.DATA, samples_json, args.only_converged)
    train = [d for d in data if not d["holdout"]]
    hold = [d for d in data if d["holdout"]]

    eo, ec, sig, inside, lvl, sample_ids, nov_rows, guard_rows = [], [], [], [], [], [], [], []
    for held in train:
        tr = [d for d in train if d["pattern"] != held["pattern"]]
        p = pr.ResidualPredictor(n_estimators=200).fit(tr, specs)
        ours = dict(zip(held["names"], held["ours"]))
        res = p.predict(specs[held["id"]], ours, ours_info[held["id"]], enforce_range=False)  # 검증: 안전장치를 끄고 보정 능력을 본다
        if res.reason:
            guard_rows.append((held["id"], res.reason, rm.rmse(held["of"], held["ours"]), rm.rmse(held["of"], [res.corrected[n] for n in held["names"]])))
        for n, of_t, o_t in zip(held["names"], held["of"], held["ours"]):
            eo.append(of_t - o_t)
            ec.append(of_t - res.corrected[n])
            sig.append(res.sigma[n])
            inside.append(res.lower90[n] <= of_t <= res.upper90[n])
            lvl.append(res.level[n])
            sample_ids.append(held["id"])
        nov_rows.append((held["id"], res.novelty, res.novelty_far, rm.rmse(held["of"], [res.corrected[n] for n in held["names"]])))
    eo, ec, sig, inside, lvl = map(np.array, (eo, ec, sig, inside, lvl))

    L = []
    L.append(f"## 불확실성 검증 (같은 고장 패턴을 통째로 빼고 학습, 샘플 {len(train)}개{', 수렴한 것만' if args.only_converged else ''}, 랙 {len(eo)}개)\n")
    L.append(f"- 랙 단위 RMSE: 우리 솔버 {np.sqrt((eo ** 2).mean()):.2f}도, 보정 {np.sqrt((ec ** 2).mean()):.2f}도")
    L.append(f"- 90% 구간(보정값 ± max({pr.INTERVAL_K:g} x 퍼짐, {pr.INTERVAL_FLOOR:g}도))에 OpenFOAM 값이 들어간 비율: **{inside.mean():.2f}**\n")
    L.append("| 신뢰 등급 | 기준(퍼짐) | 랙 수 | 우리 RMSE | 보정 RMSE | 구간 포함 비율 | 보정이 우리 솔버보다 나빠진 비율 |")
    L.append("|---|---|---|---|---|---|---|")
    for name, rule in (("ok", f"< {pr.SIGMA_CAUTION}"), ("caution", f"{pr.SIGMA_CAUTION}~{pr.SIGMA_LOW}"), ("low", f">= {pr.SIGMA_LOW}")):
        m = lvl == name
        if m.any():
            L.append(f"| {name} | {rule} | {m.sum()} | {np.sqrt((eo[m] ** 2).mean()):.2f} | {np.sqrt((ec[m] ** 2).mean()):.2f} | {inside[m].mean():.2f} | {(np.abs(ec[m]) > np.abs(eo[m])).mean():.2f} |")
    L.append("\n**퍼짐으로 우리 솔버 값으로 되돌리는 규칙은 쓰지 않는다.** 퍼짐이 클수록 보정 후에도 오차가 크지만, 보정 없는 우리 솔버는 대개 더 크게 틀린다. 퍼짐 문턱으로 되돌렸을 때의 전체 랙 RMSE:\n")
    L.append("| 문턱(퍼짐 이상이면 우리 솔버 값) | 보정 사용 비율 | 전체 RMSE |")
    L.append("|---|---|---|")
    L.append(f"| 없음(보정을 그대로 씀) | 1.00 | {np.sqrt((ec ** 2).mean()):.2f} |")
    for tau in (1.15, 0.8, 0.45):
        use = sig <= tau
        e = np.where(use, ec, eo)
        L.append(f"| {tau:g} | {use.mean():.2f} | {np.sqrt((e ** 2).mean()):.2f} |")
    L.append("")

    nov = np.array([r[1] for r in nov_rows]); sr = np.array([r[3] for r in nov_rows]); far = np.array([r[2] for r in nov_rows])
    L.append("## 샘플 단위 새로움 (가장 가까운 학습 샘플까지 거리)\n")
    L.append(f"- 거리와 샘플 RMSE의 순위 상관: {float(np.corrcoef(np.argsort(np.argsort(nov)), np.argsort(np.argsort(sr)))[0, 1]):.2f}")
    L.append(f"- 가까운 조건(거리 {pr.NOVELTY_FAR} 이하) 샘플 {int((~far).sum())}개: 보정 후 RMSE 평균 {sr[~far].mean():.2f}도, 먼 조건 샘플 {int(far.sum())}개: {sr[far].mean():.2f}도" if far.any() and (~far).any() else "")

    L.append("\n## 범위 밖 안전장치 (우리 솔버 값 그대로 되돌림)\n")
    if guard_rows:
        L.append("검증에서 안전장치가 발동했을 샘플(안전장치를 끄고 예측했을 때의 결과):\n")
        L.append("| 샘플 | 사유 | 우리 RMSE(되돌렸을 때 오차) | 보정을 그대로 썼을 때 RMSE |")
        L.append("|---|---|---|---|")
        for sid, why, a, b in guard_rows:
            L.append(f"| {sid} | {why} | {a:.2f} | {b:.2f} |")
        L.append(f"\n발동 {len(guard_rows)}개 샘플의 평균: 되돌리면 {np.mean([g[2] for g in guard_rows]):.2f}도, 보정을 쓰면 {np.mean([g[3] for g in guard_rows]):.2f}도. **안전장치는 보수적이다**: 학습에 한 번도 없던 조건에서도 보정이 도움이 된 경우가 많았다. 그래도 범위 밖에서는 검증할 근거가 없으므로 되돌린다.\n")
    full = pr.ResidualPredictor(n_estimators=100).fit(train, specs)
    base = copy.deepcopy(specs[train[0]["id"]])
    base_ours = dict(zip(train[0]["names"], train[0]["ours"]))
    info0 = ours_info[train[0]["id"]]
    cases = []
    s1 = copy.deepcopy(base); s1["row_power_kw"] = [20.0] + base["row_power_kw"][1:]; cases.append(("줄 전력 20 kW", s1))
    s2 = copy.deepcopy(base); s2["remove"] = ["Rack_01", "Rack_02", "Rack_03", "Rack_04", "Rack_05"]; cases.append(("랙 5기 제거(학습 최대 3기)", s2))
    s3 = copy.deepcopy(base); s3["fan"]["CRAC_01"] = 1.5; cases.append(("팬 레벨 1.5", s3))
    s4 = copy.deepcopy(base); s4["remove"] = ["Rack_99"]; cases.append(("없는 랙 제거", s4))
    L.append("| 입력 | 되돌림 | 이유 | 결과가 우리 솔버와 같은가 |")
    L.append("|---|---|---|---|")
    for title, s in cases:
        r = full.predict(s, base_ours, info0)
        same = all(abs(r.corrected[n] - base_ours[n]) < 1e-9 for n in r.corrected)
        L.append(f"| {title} | {r.fallback} | {r.reason} | {same} |")
    ok_r = full.predict(base, base_ours, info0)
    L.append(f"| (정상 입력, 학습 샘플 s{base['id'][1:3]}) | {ok_r.fallback} | | |")

    if hold:
        L.append("\n## 보류 사례 A, B, D, E: 구간과 신뢰 등급 (학습 샘플 전체로 학습, 처음 보는 전력 10 kW 균일)\n")
        L.append("| 사례 | 우리 RMSE | 보정 RMSE | 구간 포함 비율 | 신뢰 등급(ok/caution/low 랙 수) | 새로움 |")
        L.append("|---|---|---|---|---|---|")
        for d in hold:
            ours = dict(zip(d["names"], d["ours"]))
            r = full.predict(specs[d["id"]], ours, ours_info[d["id"]])
            vals = [r.corrected[n] for n in d["names"]]
            inc = np.mean([r.lower90[n] <= t <= r.upper90[n] for n, t in zip(d["names"], d["of"])])
            lv = [r.level[n] for n in d["names"]]
            L.append(f"| {d['id']} | {rm.rmse(d['of'], d['ours']):.2f} | {rm.rmse(d['of'], vals):.2f} | {inc:.2f} | {lv.count('ok')}/{lv.count('caution')}/{lv.count('low')} | {r.novelty:.2f}{' (먼 조건)' if r.novelty_far else ''} |")
    text = "\n".join(x for x in L if x != "")
    print(text)
    if args.report:
        args.report.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
