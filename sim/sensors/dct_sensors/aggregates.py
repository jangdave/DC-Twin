"""집계 계산(냉각 전력, 설비 전력, PUE)의 순수 함수. 합성 추정이며 실제 시설의 효율 계산이 아니다(11 데이터 규격 9장).

같은 식이 세 곳에 있다: 이 파일(센서 생성기), `web/viewer/src/sim/core.js`(브라우저 간이 계산), `gateway/src/core.js`(게이트웨이).
세 구현이 같은 입력에서 같은 값을 내는지 `tests/aggregate_vectors.json`(공유 시험 자료)으로 함께 시험한다(알람의 `alarm_vectors.json`과 같은 방식).
식을 바꾸면 `tests/make_aggregate_vectors.py`로 시험 자료를 다시 만들고 세 구현을 같이 고친다.

가정(실측 아님, 줄어드는 방향을 보이기 위한 값):
- 급기 온도가 기준(`t_supply_ref`)보다 1도 높으면 냉각 전력이 `cooling_gain_per_c`(3%)만큼 줄고 0.6~1.3배로 제한한다.
- 냉각 전력의 `cooling_load_share`(60%)가 IT 전력(열량)에 비례한다. 기준은 랙 수 x `it_ref_per_rack_kw`이고 그때 1배다.
"""
from __future__ import annotations


def chiller_factor(cfg, t_supply: float | None = None) -> float:
    """급기 온도에 따른 냉각 전력 배수. 기준 급기 온도에서 1."""
    t = cfg.t_supply if t_supply is None else t_supply
    return min(max(1.0 - cfg.cooling_gain_per_c * (t - cfg.t_supply_ref), 0.6), 1.3)


def load_factor(cfg, it_power: float, n_racks: int) -> float:
    """IT 부하에 따른 냉각 전력 배수. 기준 IT 전력(랙 수 x 랙당 기준)에서 1."""
    return 1.0 - cfg.cooling_load_share + cfg.cooling_load_share * (it_power / (cfg.it_ref_per_rack_kw * n_racks))


def cooling_power(cfg, n_crac: int, n_racks: int, fan_sum: float, it_power: float, t_supply: float | None = None) -> float:
    """냉각 전력(kW). 팬이 도는 만큼의 기본 소비에 급기 온도와 IT 부하의 배수를 곱한다."""
    return (n_crac * cfg.cooling_base_kw + cfg.fan_power_kw * fan_sum) * chiller_factor(cfg, t_supply) * load_factor(cfg, it_power, n_racks)


def facility_power(cfg, it_power: float, cooling: float) -> float:
    """설비 전력(kW) = IT 전력 + 냉각 전력 + 손실."""
    return it_power + cooling + it_power * cfg.loss_ratio
