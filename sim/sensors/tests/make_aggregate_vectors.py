"""집계 공유 시험 자료(`aggregate_vectors.json`)를 만든다. 파이썬 구현(`dct_sensors/aggregates.py`)이 기준이다.

    cd sim/sensors && uv run --python 3.13 python -m tests.make_aggregate_vectors

식(가정)을 바꾸면 이 파일을 다시 돌려 자료를 새로 만들고, 웹(`web/viewer/test/aggregates.test.js`)과 게이트웨이(`gateway/test/aggregates.test.js`)의
시험이 같은 자료로 통과하게 두 구현도 함께 고친다. 파이썬 시험(`test_aggregates.py`)은 저장된 자료가 지금 식의 결과와 같은지도 본다.
"""
from __future__ import annotations

import json
from pathlib import Path

from dct_sensors.aggregates import cooling_power, facility_power
from dct_sensors.config import Config

OUT = Path(__file__).with_name("aggregate_vectors.json")
# 집계에 쓰는 설정의 기본값. 웹과 게이트웨이의 기본값이 이 값과 같은지도 시험한다(기본값이 슬그머니 어긋나는 것을 막는다)
KEYS = ["fan_power_kw", "cooling_base_kw", "loss_ratio", "t_supply", "t_supply_ref", "cooling_gain_per_c", "it_ref_per_rack_kw", "cooling_load_share", "crac_supply_rise"]
DEFAULTS = {k: getattr(Config(), k) for k in KEYS}

# 이름, 설정 덮어쓰기, CRAC 수, 랙 수, 팬 비율 합, IT 전력(kW), 급기 온도(없으면 설정값)
CASES = [
    ("기준(60기, 팬 전부, 기준 IT 전력, 18도)", {}, 8, 60, 8.0, 440.0, None),
    ("부하 70%", {}, 8, 60, 8.0, 308.0, None),
    ("부하 130%", {}, 8, 60, 8.0, 572.0, None),
    ("급기 24도", {}, 8, 60, 8.0, 440.0, 24.0),
    ("급기 14도(최저)", {}, 8, 60, 8.0, 440.0, 14.0),
    ("급기 100도(효율 한계 0.6배에서 멈춤)", {}, 8, 60, 8.0, 440.0, 100.0),
    ("급기 -50도(효율 한계 1.3배에서 멈춤)", {}, 8, 60, 8.0, 440.0, -50.0),
    ("CRAC 한 대 정지(팬 합 7)", {}, 8, 60, 7.0, 440.0, None),
    ("팬 15%로 저하(팬 합 7.15)", {}, 8, 60, 7.15, 440.0, None),
    ("부하 130%에 급기 22도(두 효과가 곱해짐)", {}, 8, 60, 8.0, 572.0, 22.0),
    ("랙 30기(홀의 절반)는 기준도 절반", {}, 8, 30, 8.0, 220.0, None),
    ("랙 30기에 같은 IT 440 kW(과부하)", {}, 8, 30, 8.0, 440.0, None),
    ("부하 연동 끔(share 0)", {"cooling_load_share": 0.0}, 8, 60, 8.0, 572.0, None),
    ("효율 계수 끔(gain 0)", {"cooling_gain_per_c": 0.0}, 8, 60, 8.0, 440.0, 24.0),
    ("IT 전력 0", {}, 8, 60, 8.0, 0.0, None),
]


def build() -> dict:
    cases = []
    for name, over, n_crac, n_racks, fan_sum, it, t in CASES:
        cfg = Config(**over)
        cool = cooling_power(cfg, n_crac, n_racks, fan_sum, it, t)
        fac = facility_power(cfg, it, cool)
        cases.append({
            "name": name, "cfg": over, "n_crac": n_crac, "n_racks": n_racks, "fan_sum": fan_sum, "it_power": it, "t_supply": t,
            "cooling": round(cool, 6), "facility": round(fac, 6), "pue": round(fac / it, 6) if it > 0 else 0.0,
        })
    return {"_comment": "집계 공유 시험 자료. 파이썬 dct_sensors/aggregates.py가 기준이다. tests/make_aggregate_vectors.py로 만든다. 허용 오차 1e-5.", "defaults": DEFAULTS, "cases": cases}


def main() -> None:
    OUT.write_text(json.dumps(build(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(CASES)}개 사례")


if __name__ == "__main__":
    main()
