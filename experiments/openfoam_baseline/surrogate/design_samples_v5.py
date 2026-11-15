"""AI 대리 모델 학습 데이터 확장 5차: 랙 제거 + CRAC 2대 고장 샘플 12개(s75~s86)를 samples_v5.json에 만든다(시드 고정).

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/design_samples_v5.py

왜(experiments/results/E8_remove_two_off_samples.md, 2026-11-15): 4차 6개를 더하니 CAC 보류 E는 좋아졌지만 다른 보류 사례가 조금 나빠졌다.
4차 샘플끼리는 서로 도와서(하나씩 빼고 학습한 오차가 줄어듦) 개수가 모자란 것으로 보고, 같은 조합을 12개 더 모아 4차와 합쳐 18개로 다시 평가한다.

고른 방법(4차와 같은 규칙에 넓이를 더함):
- 같은 통로 쌍(01·05, 02·06, 03·07, 04·08)마다 2개씩 8개, 다른 통로 두 대 정지 4개(같은 통로만 넣으면 그쪽으로 치우친다).
- 제거는 같은 줄에서 이어진 랙 1~3기. 6줄이 고르게 나오게 줄을 돌려 가며 고르고, 줄 안의 시작 위치는 시드로 고른다.
- **보류 E와 같은 조합(CRAC_02·06 + 1줄 제거)은 넣지 않는다.** 이미 있는 샘플(학습, 4차)과 같은 (꺼진 공조기, 제거한 랙) 조합도 넣지 않는다.
- 줄별 전력은 6~14 kW에서 시드로 고른다.
samples.json은 바꾸지 않는다. 평가가 끝나 모델에 넣기로 하면 그때 합친다.
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

SEED = 20261116
CRACS = [f"CRAC_{i:02d}" for i in range(1, 9)]
SAME = [(1, 5), (2, 6), (3, 7), (4, 8)]
DIFF = [(1, 6), (3, 6), (4, 7), (2, 3)]  # 다른 통로 쌍(학습의 diff_aisle_two_off에 없는 쌍)
OUT = HERE / "samples_v5.json"


def existing() -> set:
    seen = set()
    for f in ("samples.json", "samples_v4.json"):
        for s in json.loads((HERE / f).read_text(encoding="utf-8"))["samples"]:
            off = tuple(sorted(int(k[-2:]) for k, v in s["fan"].items() if v == 0))
            seen.add((off, tuple(sorted(s["remove"]))))
    return seen


def main() -> None:
    if OUT.exists():
        print(f"{OUT.name}이 이미 있다. 아무것도 하지 않는다.")
        return
    rs = np.random.RandomState(SEED)
    seen = existing()
    pairs = [p for p in SAME for _ in range(2)] + DIFF
    rows = [i % 6 for i in range(len(pairs))]
    rs.shuffle(rows)
    S = []
    for i, (pair, row) in enumerate(zip(pairs, rows)):
        while True:
            n = int(rs.randint(1, 4))
            start = int(rs.randint(0, 10 - n + 1))
            rem = tuple(f"Rack_{row * 10 + start + k + 1:02d}" for k in range(n))
            e_like = pair == (2, 6) and row == 0
            if not e_like and (pair, rem) not in seen:
                break
            row = int(rs.randint(0, 6))
        seen.add((pair, rem))
        fan = {n_: 1.0 for n_ in CRACS}
        for k in pair:
            fan[f"CRAC_{k:02d}"] = 0.0
        group = "remove_two_off" if pair in SAME else "remove_diff_two_off"
        S.append({"id": f"s{75 + i}_{group}", "group": group, "fan": fan,
                  "row_power_kw": [round(float(x), 1) for x in rs.uniform(6.0, 14.0, 6)],
                  "remove": list(rem), "holdout": False})

    base = h.ROOT / "usd" / "scenes" / "hall01.usda"
    tmp = Path(tempfile.gettempdir()) / "dct_design_check_v5.usda"
    problems = []
    for smp in S:
        lw.apply_edits(base, tmp, {"remove": smp["remove"]})
        hall = h.read_hall(tmp)
        lay = h.Layout(hall)
        fan = np.array([smp["fan"][c["name"]] for c in hall["cracs"]], dtype=np.float32)
        q, leak = h.crac_returns(lay, fan)
        exhaust = np.asarray(lay.aisle_exhaust)
        per_aisle_q = [float(sum(q[i] for i in range(lay.n_cracs) if lay.crac_aisle[i] == a)) for a in range(lay.n_aisles)]
        ok = (q.sum() > 0 and np.allclose(np.array(per_aisle_q) + leak, exhaust, atol=1e-6) and (fan > 0).any() and len(hall["racks"]) == 60 - len(smp["remove"]))
        smp["check"] = {"racks": len(hall["racks"]), "supply_m3s": round(float(q.sum()), 2), "leak_m3s": [round(float(x), 2) for x in leak],
                        "aisle_exhaust_m3s": [round(float(x), 2) for x in exhaust], "ok": bool(ok)}
        if not ok:
            problems.append(smp["id"])
    tmp.unlink(missing_ok=True)
    OUT.write_text(json.dumps({"seed_v5": SEED, "note": "랙 제거 + CRAC 2대 고장(design_samples_v5.py)", "samples": S}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"샘플 {len(S)}개를 {OUT.name}에 만듦. 점검 실패: {problems or '없음'}")
    for s in S:
        off = [n.replace("CRAC_", "") for n, v in s["fan"].items() if v == 0]
        print(f"{s['id']:28s} off={off} rm={[r.replace('Rack_', '') for r in s['remove']]} P={s['row_power_kw']} supply={s['check']['supply_m3s']} leak={s['check']['leak_m3s']}")


if __name__ == "__main__":
    main()
