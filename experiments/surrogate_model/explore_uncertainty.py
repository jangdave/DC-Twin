"""불확실성 탐색: 패턴 통째로 빼고 학습한 예측의 앙상블 퍼짐(트리 사이 표준편차)이 실제 오차와 얼마나 맞는지 본다.
결과는 uncertainty.py의 규칙을 정하는 근거다(탐색용 스크립트, 결과는 E5 문서에 기록).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import residual_model as rm  # noqa: E402

only_conv = "--only-converged" in sys.argv
data = rm.load_dataset(rm.DATA, rm.BASE / "surrogate" / "samples.json", only_conv)
train = [d for d in data if not d["holdout"]]
print("학습 샘플", len(train), "수렴만" if only_conv else "(미수렴 포함)")

rows = []  # (샘플 id, 랙 이름, 오차(우리), 오차(보정), 퍼짐, 보정량)
for held in train:
    tr = [d for d in train if d["pattern"] != held["pattern"]]
    Xtr = np.vstack([d["X"] for d in tr])
    ytr = np.concatenate([d["of"] - d["ours"] for d in tr])
    m = ExtraTreesRegressor(n_estimators=200, min_samples_leaf=3, random_state=0, n_jobs=-1).fit(Xtr, ytr)
    per_tree = np.stack([t.predict(held["X"]) for t in m.estimators_])
    pred, spread = per_tree.mean(0), per_tree.std(0)
    err_ours = held["of"] - held["ours"]
    err_corr = held["of"] - (held["ours"] + pred)
    for k in range(len(pred)):
        rows.append((held["id"], held["group"], err_ours[k], err_corr[k], spread[k], pred[k]))
R = np.array([(r[2], r[3], r[4], r[5]) for r in rows])
eo, ec, sp, pr = R[:, 0], R[:, 1], R[:, 2], R[:, 3]
print("랙 단위 RMSE: 우리", round(float(np.sqrt((eo ** 2).mean())), 3), "보정", round(float(np.sqrt((ec ** 2).mean())), 3))


def spearman(a, b):
    ra = np.argsort(np.argsort(a)); rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


print("퍼짐과 |보정 후 오차|의 순위 상관", round(spearman(sp, np.abs(ec)), 3), "| 퍼짐과 |보정량|", round(spearman(sp, np.abs(pr)), 3))
qs = np.quantile(sp, [0, 0.25, 0.5, 0.75, 0.9, 0.95, 1.0])
print("퍼짐 분위수", np.round(qs, 3))
print("퍼짐 구간별 (랙 수, 우리 RMSE, 보정 RMSE, 보정이 오히려 나빠진 비율)")
for lo, hi in zip(qs[:-1], qs[1:]):
    m = (sp >= lo) & (sp <= hi)
    print(f"  {lo:.3f}~{hi:.3f}: {m.sum():4d}  {np.sqrt((eo[m] ** 2).mean()):.2f}  {np.sqrt((ec[m] ** 2).mean()):.2f}  {(np.abs(ec[m]) > np.abs(eo[m])).mean():.2f}")
print("\n보정 가중 w = 1 / (1 + (퍼짐/s0)^2) 로 줄였을 때 RMSE (s0가 클수록 보정을 더 믿음)")
for s0 in (0.05, 0.1, 0.2, 0.3, 0.5, 1.0, 2.0, 1e9):
    w = 1.0 / (1.0 + (sp / s0) ** 2)
    e = eo - w * pr
    print(f"  s0={s0:g}: {np.sqrt((e ** 2).mean()):.3f}  (평균 가중 {w.mean():.2f})")
print("\n하드 문턱 (퍼짐 > tau이면 보정 안 함) RMSE")
for tau in (0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 1e9):
    use = sp <= tau
    e = np.where(use, ec, eo)
    print(f"  tau={tau:g}: {np.sqrt((e ** 2).mean()):.3f}  보정 사용 {use.mean():.2f}")
# 구간 신뢰: |오차| <= k*퍼짐 인 비율
print("\n|보정 후 오차| <= k x 퍼짐 인 비율")
for k in (1, 2, 3):
    print(f"  k={k}: {(np.abs(ec) <= k * sp).mean():.2f}")


# ---- 샘플 단위 새로움(novelty): 조건 서술 벡터의 가장 가까운 학습 샘플까지 거리와 샘플 오차의 관계 ----
import json

spec = {s["id"]: s for s in json.loads((rm.BASE / "surrogate" / "samples.json").read_text(encoding="utf-8"))["samples"]}


def describe(sid):
    s = spec[sid]
    return np.array([s["fan"][f"CRAC_{i + 1:02d}"] for i in range(8)] + [p / 10.0 for p in s["row_power_kw"]] + [len(s["remove"])])


desc = {d["id"]: describe(d["id"]) for d in train}
nov, err = [], []
for held in train:
    others = [desc[d["id"]] for d in train if d["pattern"] != held["pattern"]]
    dist = np.min([np.linalg.norm(desc[held["id"]] - o) for o in others])
    tr = [d for d in train if d["pattern"] != held["pattern"]]
    Xtr = np.vstack([d["X"] for d in tr]); ytr = np.concatenate([d["of"] - d["ours"] for d in tr])
    m = ExtraTreesRegressor(n_estimators=100, min_samples_leaf=3, random_state=0, n_jobs=-1).fit(Xtr, ytr)
    e = held["of"] - (held["ours"] + m.predict(held["X"]))
    nov.append(dist); err.append(float(np.sqrt((e ** 2).mean())))
print("\n샘플 단위: 새로움(가장 가까운 학습 샘플까지 거리)과 보정 후 샘플 RMSE의 순위 상관", round(spearman(np.array(nov), np.array(err)), 3))
for q0, q1 in ((0, 0.5), (0.5, 0.8), (0.8, 1.0)):
    lo, hi = np.quantile(nov, q0), np.quantile(nov, q1)
    ix = [i for i, v in enumerate(nov) if lo <= v <= hi]
    print(f"  거리 {lo:.2f}~{hi:.2f}: 샘플 {len(ix)}개, 보정 후 RMSE 평균 {np.mean([err[i] for i in ix]):.2f}")
