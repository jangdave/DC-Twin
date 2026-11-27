"""V2 검증(docs/32): 학습에 넣지 않는 처음 보는 조건 12개와 급기 온도 1개를 samples_unseen.json에 만든다(시드 고정).

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/design_samples_unseen.py

- 시험 전용이다. 학습(samples.json, _v4, _v5)에 합치지 않는다(docs/32 4장 V2 아래 메모).
- 무작위 12개는 학습 범위 안에서 새 시드로 뽑는다: 정상 1, CRAC 1대 정지 2, 같은 통로 2대 정지 2, 다른 통로 2대 정지 2,
  팬 저하 2(0.3~0.8), 팬 깊은 저하 1(0.15~0.5), 랙 제거 + 1대 정지 1, 낮은 부하(4~6 kW) + 1대 정지 1. 줄별 전력은 6~14 kW.
- 보류 E와 같은 조합(CRAC_02·06 + 1줄 제거)은 넣지 않는다. 이미 있는 샘플과 같은 (꺼진 공조기, 제거한 랙, 팬 값, 줄 전력) 조합도 넣지 않는다.
- 급기 온도: u13은 u02와 같은 조건에 급기만 24도(`t_supply`)다. 두 계산(OpenFOAM, 우리)이 온도에 선형이면 u13 - u02가 모든 랙에서 6.0도가 된다.
  보정 모델(L2)은 이 가정으로 급기 차이를 옮겨 쓰므로(`solver_l2.py`), 이 한 쌍으로 가정을 확인한다. 16, 20, 22도는 같은 확인이라 돌리지 않는다.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "omniverse_probe"))
import hall60_sim as h  # noqa: E402
import layout_whatif as lw  # noqa: E402

SEED = 20261126
CRACS = [f"CRAC_{i:02d}" for i in range(1, 9)]
SAME = [(1, 5), (2, 6), (3, 7), (4, 8)]
OUT = HERE / "samples_unseen.json"
T_SUPPLY_CHECK = 24.0


def existing() -> set:
    seen = set()
    for f in ("samples.json", "samples_v4.json", "samples_v5.json"):
        for s in json.loads((HERE / f).read_text(encoding="utf-8"))["samples"]:
            seen.add((tuple(sorted(s["fan"].items())), tuple(sorted(s["remove"])), tuple(s["row_power_kw"])))
    return seen


def fans(off=(), derate=None) -> dict:
    f = {n: 1.0 for n in CRACS}
    for k in off:
        f[f"CRAC_{k:02d}"] = 0.0
    for k, v in (derate or {}).items():
        f[f"CRAC_{k:02d}"] = v
    return f


def main() -> None:
    if OUT.exists():
        print(f"{OUT.name}이 이미 있다. 아무것도 하지 않는다.")
        return
    rs = np.random.RandomState(SEED)
    power = lambda lo=6.0, hi=14.0: [round(float(x), 1) for x in rs.uniform(lo, hi, 6)]  # noqa: E731
    one = lambda: (int(rs.randint(1, 9)),)  # noqa: E731

    def derated(lo, hi, nmin, nmax):
        ks = rs.choice(np.arange(1, 9), size=int(rs.randint(nmin, nmax + 1)), replace=False)
        return {int(k): round(float(rs.uniform(lo, hi)), 2) for k in sorted(ks)}

    def diff_pair():
        while True:
            a, b = sorted(int(x) for x in rs.choice(np.arange(1, 9), 2, replace=False))
            if (a, b) not in SAME:
                return (a, b)

    plan = [
        ("normal", fans(), [], power()),
        ("one_crac_off", fans(one()), [], power()),
        ("one_crac_off", fans(one()), [], power()),
        ("same_aisle_two_off", fans(SAME[int(rs.randint(0, 4))]), [], power()),
        ("same_aisle_two_off", fans(SAME[int(rs.randint(0, 4))]), [], power()),
        ("diff_aisle_two_off", fans(diff_pair()), [], power()),
        ("diff_aisle_two_off", fans(diff_pair()), [], power()),
        ("fan_derated", fans(derate=derated(0.3, 0.8, 2, 4)), [], power()),
        ("fan_derated", fans(derate=derated(0.3, 0.8, 2, 4)), [], power()),
        ("fan_derated_deep", fans(derate=derated(0.15, 0.5, 1, 2)), [], power()),
    ]
    # 랙 제거 + 1대 정지: 같은 줄에서 이어진 1~3기
    row = int(rs.randint(0, 6))
    n = int(rs.randint(1, 4))
    start = int(rs.randint(0, 10 - n + 1))
    plan.append(("remove_and_fail", fans(one()), [f"Rack_{row * 10 + start + k + 1:02d}" for k in range(n)], power()))
    plan.append(("one_crac_off_low_load", fans(one()), [], power(4.0, 6.0)))

    seen = existing()
    S = []
    for i, (group, fan, rem, p) in enumerate(plan):
        key = (tuple(sorted(fan.items())), tuple(sorted(rem)), tuple(p))
        assert key not in seen, f"학습 샘플과 같은 조건: {group}"
        off = tuple(sorted(int(k[-2:]) for k, v in fan.items() if v == 0))
        assert not (off == (2, 6) and rem), "보류 E와 같은 조합"
        S.append({"id": f"u{i + 1:02d}_{group}", "group": group, "fan": fan, "row_power_kw": p, "remove": rem, "holdout": False})
    base = S[1]
    S.append({**{k: v for k, v in base.items() if k != "id"}, "id": f"u13_supply_{int(T_SUPPLY_CHECK)}", "group": "supply_shift",
              "t_supply": T_SUPPLY_CHECK, "pair": base["id"]})

    scene = h.ROOT / "usd" / "scenes" / "hall01.usda"
    tmp = Path(tempfile.gettempdir()) / "dct_design_check_unseen.usda"
    problems = []
    for smp in S:
        if smp["remove"]:
            lw.apply_edits(scene, tmp, {"remove": smp["remove"]})
            hall = h.read_hall(tmp)
        else:
            hall = h.read_hall(scene)
        lay = h.Layout(hall)
        fan = np.array([smp["fan"][c["name"]] for c in hall["cracs"]], dtype=np.float32)
        q, leak = h.crac_returns(lay, fan)
        ok = bool(q.sum() > 0 and (fan > 0).any() and len(hall["racks"]) == 60 - len(smp["remove"]))
        smp["check"] = {"racks": len(hall["racks"]), "supply_m3s": round(float(q.sum()), 2), "leak_m3s": [round(float(x), 2) for x in leak],
                        "total_power_kw": round(sum(p * 10 for p in smp["row_power_kw"]) - sum(smp["row_power_kw"][(int(r[-2:]) - 1) // 10] for r in smp["remove"]), 1), "ok": ok}
        if not ok:
            problems.append(smp["id"])
    tmp.unlink(missing_ok=True)
    OUT.write_text(json.dumps({"seed": SEED, "note": "V2 처음 보는 조건, 시험 전용(design_samples_unseen.py, docs/32)", "samples": S}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"샘플 {len(S)}개를 {OUT.name}에 만듦. 점검 실패: {problems or '없음'}")
    for s in S:
        nf = {k[-2:]: v for k, v in s["fan"].items() if v != 1.0}
        print(f"{s['id']:30s} fan={nf} rm={[r[-2:] for r in s['remove']]} P={s['row_power_kw']} t_sup={s.get('t_supply', 18.0)} supply={s['check']['supply_m3s']} leak={s['check']['leak_m3s']}")


if __name__ == "__main__":
    main()
