"""AI 대리 모델 학습 데이터 확장 4차: 랙 제거 + 같은 통로 CRAC 2대 고장 샘플 6개(s69~s74)를 samples_v4.json에 만든다(시드 고정).

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/design_samples_v4.py

왜(docs/34 6.2, 2026-11-15): CAC 보정 모델이 보류 E(랙 05·06 제거 + CRAC_02·06 정지)에서 1.8도(최대 5.6도) 틀리고 신뢰 등급도 오차를 다 잡지 못한다.
신뢰 기준은 맞았고(같은 고장 패턴을 뺀 검증에서 등급이 잘 나뉨), 학습에 이 조합이 얇다: 랙 제거 12개 중 같은 통로 2대 고장은 s47 하나다.

고른 방법:
- 같은 통로 쌍 4종류(01·05, 02·06, 03·07, 04·08)를 모두 넣는다.
- 제거는 같은 줄에서 이어진 랙 1~3기, 줄 가운데와 끝을 섞는다.
- **보류 E와 같은 조합(CRAC_02·06 + 1줄 제거)은 넣지 않는다.** 보류 사례는 처음 보는 조건으로 남겨 두어야 평가가 정직하다.
- 줄별 전력은 v2와 같이 6~14 kW에서 시드로 고른다.
samples.json은 바꾸지 않는다(HAC 모델과 녹화가 그 파일에 묶여 있다). 계산과 평가가 끝나 모델에 넣기로 하면 그때 합친다.
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

SEED = 20261115
CRACS = [f"CRAC_{i:02d}" for i in range(1, 9)]
PLAN = [  # (꺼진 CRAC 쌍, 제거할 랙 번호)
    ((2, 6), (25, 26)),        # 3줄 가운데
    ((3, 7), (35, 36)),        # 4줄 가운데
    ((1, 5), (9, 10)),         # 1줄 끝(E와 다른 쌍)
    ((4, 8), (44, 45, 46)),    # 5줄 가운데 3기
    ((3, 7), (11,)),           # 2줄 처음 1기
    ((2, 6), (58, 59, 60)),    # 6줄 끝 3기
]
OUT = HERE / "samples_v4.json"


def main() -> None:
    if OUT.exists():
        print(f"{OUT.name}이 이미 있다. 아무것도 하지 않는다.")
        return
    rs = np.random.RandomState(SEED)
    S = []
    for i, (pair, rem) in enumerate(PLAN):
        fan = {n: 1.0 for n in CRACS}
        for k in pair:
            fan[f"CRAC_{k:02d}"] = 0.0
        S.append({"id": f"s{69 + i}_remove_two_off", "group": "remove_two_off", "fan": fan,
                  "row_power_kw": [round(float(x), 1) for x in rs.uniform(6.0, 14.0, 6)],
                  "remove": [f"Rack_{r:02d}" for r in rem], "holdout": False})

    base = h.ROOT / "usd" / "scenes" / "hall01.usda"
    tmp = Path(tempfile.gettempdir()) / "dct_design_check_v4.usda"
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
    OUT.write_text(json.dumps({"seed_v4": SEED, "note": "랙 제거 + 같은 통로 CRAC 2대 고장(design_samples_v4.py)", "samples": S}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"샘플 {len(S)}개를 {OUT.name}에 만듦. 점검 실패: {problems or '없음'}")
    for s in S:
        off = [n.replace("CRAC_", "") for n, v in s["fan"].items() if v == 0]
        print(f"{s['id']:24s} off={off} rm={[r.replace('Rack_', '') for r in s['remove']]} P={s['row_power_kw']} supply={s['check']['supply_m3s']} leak={s['check']['leak_m3s']}")


if __name__ == "__main__":
    main()
