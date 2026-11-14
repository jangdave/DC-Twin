"""우리 열 시뮬레이션(hall60_sim.py)의 랙 입구 온도 오차를 OpenFOAM 기준 답으로 배우는 잔차 모델.

목적: OpenFOAM(사례당 약 10분)의 결과를 우리 솔버(약 6초)의 결과에 작은 보정을 더해 가깝게 흉내 낸다. 시각화 목적의 실험이며
공학적 정확성을 주장하지 않는다. 대리 모델은 OpenFOAM 10 cm 격자 결과를 흉내 낼 뿐, 현실이나 격자 수렴과 무관하다.

방법: 샘플(조건) 하나와 랙 하나를 한 행으로 본다. 입력은 우리 솔버가 낸 그 랙의 입구 온도와 줄, 위치, 전력, 고장 상태 등이고,
목표는 (OpenFOAM - 우리 솔버)다. 샘플 단위로 하나씩 빼고 학습해 빠진 샘플을 맞히는 방식(leave-one-sample-out)으로 검증한다.

사용 (이 폴더에서):
    uv run --python 3.13 python residual_model.py [--of-dir ../openfoam_baseline/results/surrogate] [--report out.md]
"""
from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

HERE = Path(__file__).resolve().parents[3] / "experiments" / "surrogate_model"  # 모델 파일(model.pkl)과 학습 스크립트가 있는 폴더(코드는 docs/30 M12로 sim/thermal에 옮김)
BASE = HERE.parent / "openfoam_baseline"
RES = BASE / "results"
# 학습 데이터 폴더. 기본 장면에 이중 바닥과 바닥 아래 장애물을 켠 뒤(2026-11-11, docs/33 C단계) 그 장면으로 다시 계산한 surrogate_rf를 쓴다.
# 예전(바닥 아래 공간 없음) 데이터는 results/surrogate에 남아 있다.
DATA = RES / "surrogate_rf"
DATA_CAC = RES / "surrogate_cac"  # 냉기 통로 격리(CAC) 장면으로 같은 샘플을 계산한 결과(docs/34 6장)


def read_csv(path: Path) -> dict[str, float]:
    return {r["rack_id"]: float(r["temp_c"]) for r in csv.DictReader(open(path, encoding="utf-8"))}


@dataclass
class Geometry:
    names: list[str]            # 랙 이름(장면 순서)
    row: np.ndarray             # 줄 번호(앞면 방향 축에 직각인 좌표로 묶음)
    pos_from_end: np.ndarray    # 줄 끝에서 떨어진 칸 수(0 = 끝 랙)
    row_len: np.ndarray
    hot_aisle: np.ndarray       # 뒷면이 닿는 열기 통로
    cold_aisle: np.ndarray      # 앞면이 닿는 냉기 통로
    n_hot: int
    n_cold: int


def load_geometry(layout_json: Path | None = None) -> Geometry:
    hall = json.loads((layout_json or BASE / "layout.json").read_text(encoding="utf-8"))
    racks = hall["racks"]
    names = [r["name"] for r in racks]
    n = len(racks)
    # 줄: 앞면이 향하는 축과 직각인 좌표가 같은 랙끼리(hall60_sim의 줄 계산과 같은 규칙)
    groups: dict = {}
    for i, r in enumerate(racks):
        ax = r["front"][0]
        c = [(r["min"][d] + r["max"][d]) / 2 for d in range(2)]
        groups.setdefault((ax, round(c[ax] / 10.0)), []).append((c[1 - ax], i))
    row = np.zeros(n, dtype=int)
    pos_from_end = np.zeros(n)
    row_len = np.zeros(n)
    for gi, (_, members) in enumerate(sorted(groups.items(), key=lambda kv: kv[0][1])):
        members.sort()
        L = len(members)
        for k, (_, i) in enumerate(members):
            row[i] = gi
            pos_from_end[i] = min(k, L - 1 - k)
            row_len[i] = L
    hot_centers = sorted({round((c["min"][1] + c["max"][1]) / 2 / 10.0) * 10.0 for c in hall["cracs"]})
    cold_centers = sorted({round((v["min"][1] + v["max"][1]) / 2 / 10.0) * 10.0 for v in hall["vents"]})
    hot = np.zeros(n, dtype=int)
    cold = np.zeros(n, dtype=int)
    for i, r in enumerate(racks):
        axis, sign = r["front"]
        back_y = r["min"][1] if sign > 0 else r["max"][1]
        front_y = r["max"][1] if sign > 0 else r["min"][1]
        hot[i] = int(np.argmin([abs(back_y - c) for c in hot_centers]))
        cold[i] = int(np.argmin([abs(front_y - c) for c in cold_centers]))
    return Geometry(names, row, pos_from_end, row_len, hot, cold, len(hot_centers), len(cold_centers))


def crac_aisle(n_aisles: int = 4) -> list[int]:
    """CRAC_nn이 맡는 열기 통로: 통로 a의 CRAC는 a+1, a+5(장면 규칙, 8기 4통로)."""
    return [(i % n_aisles) for i in range(8)]


def sample_features(geo: Geometry, sample: dict, ours: dict[str, float], ours_info: dict) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """샘플 하나의 (특징 행렬, 우리 값 벡터, 랙 이름 목록). 제거한 랙은 뺀다."""
    removed = set(sample.get("remove", []))
    fan = [sample["fan"][f"CRAC_{i + 1:02d}"] for i in range(8)]
    aisle_of = crac_aisle(geo.n_hot)
    aisle_fan = np.zeros(geo.n_hot)
    for i, a in enumerate(aisle_of):
        aisle_fan[a] += fan[i]
    aisle_fan /= 2.0                              # 통로당 CRAC 2대 기준 0~1
    leak = np.array(ours_info["aisle_leak_m3s"], dtype=float)
    supply = float(ours_info["supply_m3s"])
    row_p = np.array(sample["row_power_kw"], dtype=float)
    idx_by_name = {n: i for i, n in enumerate(geo.names)}
    rows, ours_vec, names = [], [], []
    for n in geo.names:
        if n in removed or n not in ours:
            continue
        i = idx_by_name[n]
        r = geo.row[i]
        # 같은 줄에서 가까운 제거 랙(2칸 이내) 수와 같은 냉기 통로에서 제거된 랙 수
        near_removed = 0
        cold_removed = 0
        for m in removed:
            j = idx_by_name[m]
            if geo.row[j] == r and abs((geo.pos_from_end[j] if True else 0) - geo.pos_from_end[i]) <= 2:
                near_removed += 1
            if geo.cold_aisle[j] == geo.cold_aisle[i]:
                cold_removed += 1
        ha = geo.hot_aisle[i]
        rows.append([
            ours[n],                                  # 우리 솔버의 입구 온도
            ours[n] - 18.0,
            row_p[r] / 10.0,
            geo.pos_from_end[i],
            1.0 if geo.pos_from_end[i] == 0 else 0.0,
            geo.row_len[i],
            r,
            aisle_fan[ha],                            # 이 랙 뒤 열기 통로의 CRAC 가동 정도
            leak[ha],                                 # 그 통로에서 새는 양
            leak.sum(),
            supply / 57.6,
            float(np.mean(fan)),
            float(np.sum(np.array(fan) == 0.0)),
            sum(row_p) / 60.0 / 10.0,
            near_removed,
            cold_removed,
            geo.cold_aisle[i],
        ])
        ours_vec.append(ours[n])
        names.append(n)
    return np.array(rows, dtype=float), np.array(ours_vec), names


FEATURE_NAMES = ["ours", "ours-18", "row_power/10", "pos_from_end", "is_end", "row_len", "row", "hot_aisle_fan", "hot_aisle_leak", "total_leak",
                 "supply/57.6", "mean_fan", "n_fan_off", "mean_power/10", "near_removed", "cold_removed", "cold_aisle"]


def pattern_key(sample: dict) -> str:
    """고장 패턴의 대표 키. 홀이 좌우 대칭(통로 a와 3-a가 거울상)이라 거울상 패턴은 같은 키로 묶는다.
    제거한 랙이 있는 샘플은 모두 한 묶음('remove')으로 본다(랙 이름의 거울상 대응은 따로 만들지 않았다)."""
    if sample.get("remove"):
        return "remove"
    fan = [round(sample["fan"][f"CRAC_{i + 1:02d}"], 2) for i in range(8)]
    mirror = [fan[(i // 4) * 4 + (3 - (i % 4))] for i in range(8)]
    return "fan:" + str(min(tuple(fan), tuple(mirror)))


def load_dataset(of_dir: Path, samples_json: Path, only_converged: bool = False):
    spec = json.loads(samples_json.read_text(encoding="utf-8"))["samples"]
    ours_info = json.loads((of_dir / "ours_progress.json").read_text(encoding="utf-8"))
    progress_path = of_dir / "progress.json"
    progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.exists() else {}
    geo = load_geometry()
    data = []
    for s in spec:
        sid = s["id"]
        if s.get("holdout"):
            # 데이터 폴더에 같은 장면으로 다시 계산한 보류 결과(of_<id>.csv)가 있으면 그것을 쓴다(이중 바닥 장면은 surrogate_rf, docs/33 7장).
            # 처음 계산한 결과(existing_of)는 이중 바닥 전 장면이라 그 장면의 데이터 폴더(surrogate)에서만 쓴다. 다른 폴더에서 없으면
            # 장면이 다른 두 계산을 비교하게 되므로 멈춘다(2026-11-13 재검토).
            own = of_dir / f"of_{sid}.csv"
            if own.exists():
                of_path = own
            elif Path(of_dir).resolve() == (RES / "surrogate").resolve():
                of_path = RES / s["existing_of"]
            else:
                raise FileNotFoundError(f"보류 사례 {sid}의 OpenFOAM 결과가 {of_dir}에 없다(이 장면으로 다시 계산해야 한다)")
        else:
            of_path = of_dir / f"of_{sid}.csv"
        ours_path = of_dir / f"ours_{sid}.csv"
        if not of_path.exists() or not ours_path.exists():
            continue
        status = progress.get(sid, {}).get("status", "done" if s.get("holdout") else "?")
        if status == "failed":
            continue
        if only_converged and not s.get("holdout") and status != "done":
            continue
        of = read_csv(of_path)
        ours = read_csv(ours_path)
        X, o, names = sample_features(geo, s, ours, ours_info[sid])
        y_of = np.array([of[n] for n in names])
        data.append({"id": sid, "group": s["group"], "holdout": bool(s.get("holdout")), "status": status, "pattern": pattern_key(s), "X": X, "ours": o, "of": y_of, "names": names})
    return data


def rmse(a, b) -> float:
    return float(np.sqrt(np.mean((np.asarray(a) - np.asarray(b)) ** 2)))


def make_models():
    return {
        "우리 솔버 그대로": None,
        "평균 편향 보정": "bias",
        "릿지(선형)": lambda: Ridge(alpha=1.0),
        "엑스트라 트리": lambda: ExtraTreesRegressor(n_estimators=300, min_samples_leaf=3, random_state=0, n_jobs=-1),
        "그래디언트 부스팅": lambda: HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_depth=4, random_state=0),
    }


def fit_predict(kind, Xtr, ytr, Xte):
    if kind is None:
        return np.zeros(len(Xte))
    if kind == "bias":
        return np.full(len(Xte), float(np.mean(ytr)))
    model = kind()
    # 선형 모델은 특징 크기를 맞춘다
    if isinstance(model, Ridge):
        mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-9
        model.fit((Xtr - mu) / sd, ytr)
        return model.predict((Xte - mu) / sd)
    model.fit(Xtr, ytr)
    return model.predict(Xte)


def leave_group_out(train_data, split: str = "sample"):
    """묶음 하나씩 빼고 나머지로 학습해 빠진 샘플들을 맞힌다. {모델 이름: [샘플별 보정 후 RMSE]}
    split: sample(샘플 하나), pattern(같은 고장 패턴과 그 거울상 전부), group(설계 그룹 전부).
    샘플 하나만 빼면 거울상이나 같은 패턴의 다른 전력 샘플이 학습에 남아 결과가 낙관적이다."""
    models = make_models()
    out = {name: [] for name in models}
    label = {"sample": lambda d: d["id"], "pattern": lambda d: d["pattern"], "group": lambda d: d["group"]}[split]
    for k, held in enumerate(train_data):
        tr = [d for d in train_data if label(d) != label(held)]
        if len(tr) < 3:
            for name in models:
                out[name].append(float("nan"))
            continue
        Xtr = np.vstack([d["X"] for d in tr])
        ytr = np.concatenate([d["of"] - d["ours"] for d in tr])
        for name, kind in models.items():
            pred = fit_predict(kind, Xtr, ytr, held["X"])
            out[name].append(rmse(held["ours"] + pred, held["of"]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="우리 솔버의 오차를 배우는 잔차 모델: leave-one-sample-out 검증과 보류 사례 평가")
    ap.add_argument("--of-dir", type=Path, default=DATA)
    ap.add_argument("--samples", type=Path, default=BASE / "surrogate" / "samples.json")
    ap.add_argument("--report", type=Path, default=None, help="결과를 이 마크다운 파일로도 저장")
    ap.add_argument("--only-converged", action="store_true", help="수렴한 샘플만 학습과 검증에 쓴다(미수렴 제외)")
    ap.add_argument("--split", choices=["sample", "pattern", "group"], default="sample", help="검증에서 한 번에 빼는 묶음")
    args = ap.parse_args()

    data = load_dataset(args.of_dir, args.samples, args.only_converged)
    train = [d for d in data if not d["holdout"]]
    hold = [d for d in data if d["holdout"]]
    print(f"학습 샘플 {len(train)}개, 보류 {len(hold)}개")
    if len(train) < 5:
        raise SystemExit("학습 샘플이 5개보다 적다. OpenFOAM 계산이 더 끝난 뒤 다시 실행한다.")

    lines = []
    loo = leave_group_out(train, args.split)
    names = {"sample": "샘플 하나씩", "pattern": "같은 고장 패턴(거울상 포함)을 통째로", "group": "설계 그룹을 통째로"}
    lines.append(f"## {names[args.split]} 빼고 학습한 검증 (샘플 {len(train)}개{', 수렴한 것만' if args.only_converged else ''}, 샘플별 랙 RMSE의 평균/중앙값, 도)\n")
    lines.append("| 모델 | 평균 RMSE | 중앙값 | 우리 솔버 대비 평균 개선 |")
    lines.append("|---|---|---|---|")
    base = float(np.nanmean(loo["우리 솔버 그대로"]))
    for name, vals in loo.items():
        lines.append(f"| {name} | {np.nanmean(vals):.2f} | {np.nanmedian(vals):.2f} | {100 * (1 - np.nanmean(vals) / base):+.0f}% |")
    groups = sorted({d["group"] for d in train})
    lines.append("\n그룹별 평균 RMSE (그래디언트 부스팅 / 엑스트라 트리 / 우리 솔버):\n")
    lines.append("| 그룹 | 개수 | 우리 솔버 | 엑스트라 트리 | 그래디언트 부스팅 |")
    lines.append("|---|---|---|---|---|")
    for g in groups:
        ix = [i for i, d in enumerate(train) if d["group"] == g]
        lines.append(f"| {g} | {len(ix)} | {np.mean([loo['우리 솔버 그대로'][i] for i in ix]):.2f} | {np.mean([loo['엑스트라 트리'][i] for i in ix]):.2f} | {np.mean([loo['그래디언트 부스팅'][i] for i in ix]):.2f} |")

    if hold:
        Xtr = np.vstack([d["X"] for d in train])
        ytr = np.concatenate([d["of"] - d["ours"] for d in train])
        lines.append(f"\n## 보류 사례 (학습 샘플 {len(train)}개 전체로 학습, 처음 보는 사례)\n")
        lines.append("| 사례 | 우리 솔버 RMSE | 평균 편향 보정 | 엑스트라 트리 | 그래디언트 부스팅 |")
        lines.append("|---|---|---|---|---|")
        models = make_models()
        for d in hold:
            cells = []
            for name in ("우리 솔버 그대로", "평균 편향 보정", "엑스트라 트리", "그래디언트 부스팅"):
                pred = fit_predict(models[name], Xtr, ytr, d["X"])
                cells.append(f"{rmse(d['ours'] + pred, d['of']):.2f}")
            lines.append(f"| {d['id']} | " + " | ".join(cells) + " |")
    text = "\n".join(lines)
    print(text)
    if args.report:
        args.report.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
