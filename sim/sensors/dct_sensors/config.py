"""생성기 매개변수. 모두 "그럴듯하게 보이게" 정한 값이며 측정값이 아니다(11 데이터 규격 6.2장). JSON으로 덮어쓸 수 있다."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path


@dataclass
class Config:
    # ---- 시간 ----
    interval_s: float = 1.0          # 발행 주기(시뮬레이션 시간 기준)
    start_ts: str = "2026-10-15T09:00:00.000Z"
    # ---- 센서 잡음(표준편차) ----
    noise_temp: float = 0.08         # degC
    noise_power: float = 0.05        # kW
    noise_fan: float = 0.3           # percent
    # ---- 랙 전력(kW) ----
    power_base_min: float = 6.0
    power_base_max: float = 8.5
    power_wobble: float = 0.6        # 완만한 오르내림 크기(kW)
    power_period_s: float = 150.0
    # ---- L0 모델 ----
    tau_s: float = 60.0              # 1차 지연 시간 상수
    t_supply: float = 18.0           # 급기 온도(degC)
    inlet_base_rise: float = 0.6     # 정상일 때 입구 온도가 급기보다 높은 정도(K)
    recirc_gain: float = 36.0        # 냉각이 줄 때(1 - 담당 CRAC 팬 비율) 입구 온도가 오르는 정도(K), 전력 기준(power_ref)에서
    power_ref: float = 10.0          # kW
    inlet_power_coeff: float = 6.0   # 전력이 기준의 80%를 넘으면 입구 온도가 오르는 정도(K, 기준 전력 1배당)
    end_rack_factor: float = 1.15    # 줄 끝 랙은 더 뜨겁다(열 시뮬레이션 결과와 방향이 같다)
    outlet_dt_ref: float = 10.4      # 전력 power_ref에서 랙 출구 - 입구 온도 차(K)
    crac_supply_rise: float = 6.0    # CRAC 팬이 멈추면 공급 온도가 오르는 정도(K)
    return_offset: float = -3.0      # 회수 온도 = 담당 줄 랙 출구 평균 + 이 값
    # ---- 알람(11 데이터 규격 4.4장) ----
    hysteresis: float = 0.5
    consecutive: int = 2
    # ---- 집계(11 데이터 규격 9장) ----
    fan_power_kw: float = 3.0        # CRAC 1기 팬 100%일 때 전력 추정
    cooling_base_kw: float = 1.0     # CRAC 1기 기본 소비
    loss_ratio: float = 0.06         # 손실(IT 전력의 비율)
    # 급기 온도와 냉각 효율(가정, 실측 아님): 기준보다 1도 올리면 냉각 전력이 약 3% 줄고 내리면 늘며 0.6~1.3배로 제한한다. 웹 간이 시뮬레이션과 같은 값.
    t_supply_ref: float = 18.0       # 기준 급기 온도(degC). 보정 모델(L2)도 이 온도에서 배웠다
    cooling_gain_per_c: float = 0.03
    # 냉각 전력과 IT 부하(가정, 실측 아님): 냉각 전력의 일부(cooling_load_share)가 IT 전력(열량)에 비례한다. 기준은 랙 수 x 랙 1기당 기준 전력(정상 가동의 평균)이고 그때 1배.
    # 예) 부하가 30% 줄면 냉각 전력이 18% 줄고(1 - 0.6 + 0.6 x 0.7 = 0.82배), 30% 늘면 18% 는다. 나머지(1 - share)는 부하와 무관한 고정분(팬 등)이다.
    # 랙 수에 비례하는 기준이라 랙을 옮기거나 빼도(랙 수가 달라져도) 같은 규칙이 맞는다.
    it_ref_per_rack_kw: float = 440.0 / 60.0
    cooling_load_share: float = 0.6

    @classmethod
    def load(cls, path: str | Path | None) -> "Config":
        c = cls()
        if path:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            names = {f.name for f in fields(cls)}
            unknown = set(data) - names
            if unknown:
                raise ValueError(f"알 수 없는 설정 이름: {sorted(unknown)}")
            for k, v in data.items():
                setattr(c, k, v)
        return c

    def to_dict(self) -> dict:
        return asdict(self)
