"""V2 검증(docs/32): 학습에 넣지 않은 처음 보는 조건(samples_unseen.json)에서, 지금 쓰는 보정 모델(model.pkl 또는 model_cac.pkl)이
OpenFOAM과 얼마나 맞는지 본다. 모델은 다시 학습하지 않는다(서버와 녹화가 쓰는 파일 그대로).

사용 (이 폴더에서):
    uv run --python 3.13 python evaluate_unseen.py --res ../openfoam_baseline/results/surrogate_unseen [--cac] [--report 결과.md]

- L2(`sim/sensors/dct_sensors/solver_l2.py`)와 같은 방식으로 부른다: 범위 안전장치를 켜고(enforce_range=True), 급기 온도가 18도가 아니면
  우리 값에서 그 차이를 빼서 넣고 결과에 다시 더한다. 그때 ok 등급은 caution으로 낮춘다(L2와 같다).
- 급기 온도 짝(`pair`가 있는 샘플)은 OpenFOAM과 우리 계산이 온도에 선형인지(차이가 모든 랙에서 급기 차이와 같은지)도 본다.
- 결과 폴더에 OpenFOAM 결과(of_<id>.csv)가 아직 없는 샘플은 건너뛴다(계산 도중에도 돌릴 수 있다).
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

import predictor as pr
import residual_model as rm

HERE = Path(__file__).resolve().parent
T_REF = 18.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", type=Path, default=rm.BASE / "surrogate" / "samples_unseen.json")
    ap.add_argument("--res", type=Path, required=True, help="OpenFOAM(of_<id>.csv, progress.json)과 우리 계산(ours_<id>.csv, ours_progress.json) 결과 폴더")
    ap.add_argument("--cac", action="store_true", help="CAC 장면 결과와 model_cac.pkl")
    ap.add_argument("--report", type=Path, default=None)
    a = ap.parse_args()

    pkl = HERE / ("model_cac.pkl" if a.cac else "model.pkl")
    p = pr.ResidualPredictor.load(pkl)
    meta = json.loads(pkl.with_suffix(".meta.json").read_text(encoding="utf-8"))
    specs = json.loads(a.spec.read_text(encoding="utf-8"))["samples"]
    ours_info = json.loads((a.res / "ours_progress.json").read_text(encoding="utf-8"))
    prog_path = a.res / "progress.json"
    prog = json.loads(prog_path.read_text(encoding="utf-8")) if prog_path.exists() else {}

    rows, all_o, all_c, all_in, all_lvl, by_group = [], [], [], [], [], defaultdict(lambda: ([], []))
    raw = {}
    for s in specs:
        sid = s["id"]
        of_p, ou_p = a.res / f"of_{sid}.csv", a.res / f"ours_{sid}.csv"
        if not of_p.exists() or not ou_p.exists() or prog.get(sid, {}).get("status") == "failed":
            continue
        of, ours_raw = rm.read_csv(of_p), rm.read_csv(ou_p)
        raw[sid] = (of, ours_raw)
        shift = float(s.get("t_supply", T_REF)) - T_REF
        ours = {n: v - shift for n, v in ours_raw.items()}
        r = p.predict(s, ours, ours_info[sid])
        names = [n for n in r.corrected if n in of]
        o = np.array([ours_raw[n] for n in names])
        c = np.array([r.corrected[n] + shift for n in names])
        lo = np.array([r.lower90[n] + shift for n in names])
        hi = np.array([r.upper90[n] + shift for n in names])
        y = np.array([of[n] for n in names])
        # L2와 같은 등급 제한: 급기 온도가 18도가 아니거나, 천장 회수 HAC에서 급기가 모자라면(새는 양 > 0.01, solver_l2.LEAK_CAUTION_M3S) ok -> caution
        short = (not a.cac) and sum(ours_info[sid].get("aisle_leak_m3s", [0.0])) > 0.01
        lvl = [("caution" if ((abs(shift) > 1e-9 or short) and r.level[n] == "ok") else r.level[n]) for n in names]
        inside = (lo <= y) & (y <= hi)
        all_o += list(y - o)
        all_c += list(y - c)
        all_in += list(inside)
        all_lvl += lvl
        g = by_group[s["group"]]
        g[0].extend(y - o)
        g[1].extend(y - c)
        cnt = {k: lvl.count(k) for k in ("ok", "caution", "low", "fallback") if lvl.count(k)}
        rows.append((sid, prog.get(sid, {}).get("status", "?"), rm.rmse(y, o), rm.rmse(y, c), float(np.max(np.abs(y - c))), float(inside.mean()), cnt, r.novelty, r.reason))

    L = [f"## 처음 보는 조건 검증({'CAC' if a.cac else 'HAC'}, 모델 `{pkl.name}`, 학습 {meta['n_samples']}개, 학습 시각 {meta['trained_at']})\n",
         f"- 샘플 {len(rows)}개, 랙 {len(all_o)}기. 결과 폴더 `{a.res.name}`.",
         ]
    if all_o:
        all_o, all_c, all_in, all_lvl = map(np.array, (all_o, all_c, all_in, all_lvl))
        L.append(f"- 랙 단위 RMSE: 우리 계산 {np.sqrt((all_o ** 2).mean()):.2f}도, **보정 {np.sqrt((all_c ** 2).mean()):.2f}도**, 보정 최대 오차 {np.max(np.abs(all_c)):.2f}도, 구간 포함 {all_in.mean():.2f}\n")
        L.append("| 샘플 | OpenFOAM | 우리 RMSE | 보정 RMSE | 보정 최대 | 구간 포함 | 등급(랙 수) | 새로움 | 비고 |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        for sid, st, ro, rc, mx, inc, cnt, nov, reason in rows:
            L.append(f"| {sid} | {st} | {ro:.2f} | {rc:.2f} | {mx:.2f} | {inc:.2f} | {', '.join(f'{k} {v}' for k, v in cnt.items())} | {nov:.2f} | {reason} |")
        L.append("\n### 조건 묶음별\n")
        L.append("| 묶음 | 랙 수 | 우리 RMSE | 보정 RMSE |")
        L.append("|---|---|---|---|")
        for g, (eo, ec) in by_group.items():
            eo, ec = np.array(eo), np.array(ec)
            L.append(f"| {g} | {len(eo)} | {np.sqrt((eo ** 2).mean()):.2f} | {np.sqrt((ec ** 2).mean()):.2f} |")
        L.append("\n### 신뢰 등급별\n")
        L.append("| 등급 | 랙 수 | 보정 RMSE | 구간 포함 |")
        L.append("|---|---|---|---|")
        for k in ("ok", "caution", "low", "fallback"):
            m = all_lvl == k
            if m.any():
                L.append(f"| {k} | {int(m.sum())} | {np.sqrt((all_c[m] ** 2).mean()):.2f} | {all_in[m].mean():.2f} |")
    pairs = [s for s in specs if s.get("pair") and s["id"] in raw and s["pair"] in raw]
    if pairs:
        L.append("\n### 급기 온도 선형 확인(같은 조건, 급기만 다름)\n")
        L.append("| 샘플 | 급기 차이 | OpenFOAM 차이 평균 | OpenFOAM 차이 범위 | 우리 차이 평균 | 우리 차이 범위 |")
        L.append("|---|---|---|---|---|---|")
        for s in pairs:
            (of1, ou1), (of0, ou0) = raw[s["id"]], raw[s["pair"]]
            dT = float(s["t_supply"]) - T_REF
            names = [n for n in of1 if n in of0]
            d_of = np.array([of1[n] - of0[n] for n in names])
            d_ou = np.array([ou1[n] - ou0[n] for n in names])
            L.append(f"| {s['id']} - {s['pair']} | {dT:.1f} | {d_of.mean():.3f} | {d_of.min():.3f} ~ {d_of.max():.3f} | {d_ou.mean():.3f} | {d_ou.min():.3f} ~ {d_ou.max():.3f} |")
    text = "\n".join(L)
    print(text)
    if a.report:
        a.report.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
