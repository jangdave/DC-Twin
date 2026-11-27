## 처음 보는 조건 검증(HAC, 모델 `model.pkl`, 학습 68개, 학습 시각 2026-11-20T17:06:31+00:00)

- 샘플 13개, 랙 778기. 결과 폴더 `surrogate_unseen`.
- 랙 단위 RMSE: 우리 계산 1.37도, **보정 0.39도**, 보정 최대 오차 3.73도, 구간 포함 0.98

| 샘플 | OpenFOAM | 우리 RMSE | 보정 RMSE | 보정 최대 | 구간 포함 | 등급(랙 수) | 새로움 | 비고 |
|---|---|---|---|---|---|---|---|---|
| u01_normal | not_converged | 1.21 | 0.16 | 0.77 | 1.00 | ok 58, caution 2 | 0.43 |  |
| u02_one_crac_off | not_converged | 1.48 | 0.27 | 1.09 | 1.00 | ok 56, caution 4 | 0.45 |  |
| u03_one_crac_off | not_converged | 1.40 | 0.14 | 0.58 | 1.00 | ok 56, caution 4 | 0.57 |  |
| u04_same_aisle_two_off | not_converged | 1.14 | 0.12 | 0.58 | 1.00 | ok 57, caution 3 | 0.53 |  |
| u05_same_aisle_two_off | not_converged | 1.22 | 0.15 | 0.73 | 1.00 | ok 56, caution 4 | 0.59 |  |
| u06_diff_aisle_two_off | not_converged | 1.23 | 0.51 | 1.77 | 0.93 | ok 53, caution 7 | 1.20 |  |
| u07_diff_aisle_two_off | not_converged | 1.17 | 0.29 | 1.26 | 1.00 | ok 54, caution 6 | 1.12 |  |
| u08_fan_derated | not_converged | 1.29 | 0.27 | 1.49 | 1.00 | ok 52, caution 8 | 0.91 |  |
| u09_fan_derated | not_converged | 2.31 | 1.01 | 3.73 | 0.97 | ok 41, caution 7, low 12 | 1.09 |  |
| u10_fan_derated_deep | not_converged | 1.31 | 0.46 | 1.80 | 0.90 | ok 53, caution 7 | 0.90 |  |
| u11_remove_and_fail | not_converged | 1.28 | 0.26 | 1.22 | 1.00 | ok 49, caution 9 | 0.77 |  |
| u12_one_crac_off_low_load | not_converged | 0.69 | 0.23 | 1.02 | 0.97 | ok 60 | 1.01 |  |
| u13_supply_24 | not_converged | 1.48 | 0.27 | 1.09 | 1.00 | caution 60 | 0.45 |  |

### 조건 묶음별

| 묶음 | 랙 수 | 우리 RMSE | 보정 RMSE |
|---|---|---|---|
| normal | 60 | 1.21 | 0.16 |
| one_crac_off | 120 | 1.44 | 0.21 |
| same_aisle_two_off | 120 | 1.18 | 0.14 |
| diff_aisle_two_off | 120 | 1.20 | 0.41 |
| fan_derated | 120 | 1.87 | 0.74 |
| fan_derated_deep | 60 | 1.31 | 0.46 |
| remove_and_fail | 58 | 1.28 | 0.26 |
| one_crac_off_low_load | 60 | 0.69 | 0.23 |
| supply_shift | 60 | 1.48 | 0.27 |

### 신뢰 등급별

| 등급 | 랙 수 | 보정 RMSE | 구간 포함 |
|---|---|---|---|
| ok | 645 | 0.26 | 0.98 |
| caution | 121 | 0.58 | 0.98 |
| low | 12 | 1.74 | 1.00 |

### 급기 온도 선형 확인(같은 조건, 급기만 다름)

| 샘플 | 급기 차이 | OpenFOAM 차이 평균 | OpenFOAM 차이 범위 | 우리 차이 평균 | 우리 차이 범위 |
|---|---|---|---|---|---|
| u13_supply_24 - u02_one_crac_off | 6.0 | 6.000 | 5.996 ~ 6.003 | 6.000 | 6.000 ~ 6.001 |
