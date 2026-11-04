"""AI 대리 모델 학습 데이터 확장 3차: samples.json에 낮은 부하 샘플 8개(s61~s68)를 덧붙인다(시드 고정, 기존 샘플은 그대로).

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/surrogate/design_samples_v3.py

왜: 미리 계산한 시뮬레이션 모음의 "부하 70%"(랙당 약 4.2~6 kW)가 학습 범위(줄 전력 6~14 kW) 밖이라, 보정 모델이 60기 모두에서
범위 밖 안전장치(fallback)로 보정 없이 L1 값을 그대로 냈다(docs/27 16.9). 낮은 부하의 OpenFOAM 기준 답을 더해 그 영역을 채운다.

넓히는 방향(줄별 전력은 모두 4.0~6.0 kW):
- 정상(팬 전부 1.0) 3개 (전력 수준을 달리)
- CRAC 1대 고장 2개
- 팬 저하(0.3~0.6) 2개
- 같은 통로 CRAC 2대 고장 1개 (가장 강한 고장이지만 전력이 낮아 수렴 가능성이 높다)
이미 s61 이상이 있으면 아무것도 하지 않는다.
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

SEED = 20261104
CRACS = [f"CRAC_{i:02d}" for i in range(1, 9)]


def main() -> None:
    path = HERE / "samples.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    old = [s for s in data["samples"] if not s.get("holdout")]
    held = [s for s in data["samples"] if s.get("holdout")]
    if any(int(s["id"][1:3]) >= 61 for s in old):
        print("이미 확장됨(s61 이상이 있다). 아무것도 하지 않는다.")
        return
    base_n = max(int(s["id"][1:3]) for s in old)
    rs = np.random.RandomState(SEED)

    def powers(lo=4.0, hi=6.0) -> list[float]:
        return [round(float(x), 1) for x in rs.uniform(lo, hi, 6)]

    def fan_of(off=(), partial=None) -> dict:
        f = {n: 1.0 for n in CRACS}
        for n in off:
            f[n] = 0.0
        for n, v in (partial or {}).items():
            f[n] = round(float(v), 2)
        return f

    S: list[dict] = []

    def add(group, fan, p):
        S.append({"id": f"s{base_n + len(S) + 1:02d}_{group}", "group": group, "fan": fan, "row_power_kw": p, "remove": [], "holdout": False})

    for lo, hi in ((4.0, 4.8), (4.6, 5.4), (5.2, 6.0)):  # 전력 수준을 세 단계로
        add("normal_low_load", fan_of(), powers(lo, hi))
    for _ in range(2):
        add("one_crac_off_low_load", fan_of([CRACS[int(rs.randint(0, 8))]]), powers())
    for _ in range(2):
        k = int(rs.randint(1, 3))
        idx = rs.choice(8, k, replace=False)
        add("fan_derated_low_load", fan_of(partial={CRACS[i]: rs.uniform(0.3, 0.6) for i in idx}), powers())
    a = int(rs.randint(0, 4))
    add("same_aisle_two_off_low_load", fan_of((f"CRAC_{a + 1:02d}", f"CRAC_{a + 5:02d}")), powers())
    assert len(S) == 8, len(S)

    # 유량 점검(v2와 같은 방식): 켜진 CRAC가 있고 통로별 배기량이 맞는지
    hall = h.read_hall(h.ROOT / "usd" / "scenes" / "hall01.usda")
    lay = h.Layout(hall)
    problems = []
    for smp in S:
        fan = np.array([smp["fan"][c["name"]] for c in hall["cracs"]], dtype=np.float32)
        q, leak = h.crac_returns(lay, fan)
        exhaust = np.asarray(lay.aisle_exhaust)
        per_aisle_q = [float(sum(q[i] for i in range(lay.n_cracs) if lay.crac_aisle[i] == a_)) for a_ in range(lay.n_aisles)]
        ok = bool(q.sum() > 0 and np.allclose(np.array(per_aisle_q) + leak, exhaust, atol=1e-6) and (fan > 0).any())
        smp["check"] = {"racks": len(hall["racks"]), "supply_m3s": round(float(q.sum()), 2), "leak_m3s": [round(float(x), 2) for x in leak],
                        "aisle_exhaust_m3s": [round(float(x), 2) for x in exhaust], "ok": ok}
        if not ok:
            problems.append(smp["id"])
    data["samples"] = old + S + held
    data["seed_v3"] = SEED
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"샘플 {len(S)}개 추가(총 학습 {len(old) + len(S)}개). 점검 실패: {problems or '없음'}")
    for s in S:
        off = [n.replace("CRAC_", "") for n, v in s["fan"].items() if v == 0]
        part = {n.replace("CRAC_", ""): v for n, v in s["fan"].items() if 0 < v < 1}
        print(f"{s['id']:40s} off={off} partial={part} P={s['row_power_kw']} supply={s['check']['supply_m3s']}")
    tmp = Path(tempfile.gettempdir()) / "dct_design_check_v3.usda"
    tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
