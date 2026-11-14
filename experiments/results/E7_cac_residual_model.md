# E7. CAC 장면의 보정 모델 평가

- 상태: 채택 (2026-11-14). 요약과 해석은 `docs/34` 6장.
- 데이터: `experiments/openfoam_baseline/results/surrogate_cac/`(OpenFOAM 72개, CAC 장면). 명령(`sim/thermal`): `uv run --python 3.13 python -m dct_thermal.residual_model --of-dir ../../experiments/openfoam_baseline/results/surrogate_cac`
- 시각화 목적이며 공학적 정확성을 주장하지 않는다.

## 샘플 하나씩 빼고 학습한 검증 (샘플 68개, 샘플별 랙 RMSE의 평균/중앙값, 도)

| 모델 | 평균 RMSE | 중앙값 | 우리 솔버 대비 평균 개선 |
|---|---|---|---|
| 우리 솔버 그대로 | 1.12 | 0.70 | +0% |
| 평균 편향 보정 | 0.89 | 0.38 | +20% |
| 릿지(선형) | 0.78 | 0.67 | +30% |
| 엑스트라 트리 | 0.39 | 0.27 | +65% |
| 그래디언트 부스팅 | 0.46 | 0.29 | +59% |

그룹별 평균 RMSE (그래디언트 부스팅 / 엑스트라 트리 / 우리 솔버):

| 그룹 | 개수 | 우리 솔버 | 엑스트라 트리 | 그래디언트 부스팅 |
|---|---|---|---|---|
| diff_aisle_two_off | 6 | 0.89 | 0.41 | 0.42 |
| fan_derated | 6 | 0.76 | 0.40 | 0.45 |
| fan_derated_deep | 4 | 0.62 | 0.24 | 0.25 |
| fan_derated_low_load | 2 | 0.27 | 0.11 | 0.10 |
| normal | 4 | 0.45 | 0.05 | 0.09 |
| normal_low_load | 3 | 0.22 | 0.03 | 0.04 |
| one_crac_off | 10 | 0.57 | 0.18 | 0.20 |
| one_crac_off_high_power | 4 | 0.74 | 0.22 | 0.30 |
| one_crac_off_low_load | 2 | 0.29 | 0.15 | 0.13 |
| remove_and_fail | 12 | 2.46 | 0.91 | 1.17 |
| same_aisle_two_off | 14 | 1.47 | 0.38 | 0.43 |
| same_aisle_two_off_low_load | 1 | 1.28 | 1.09 | 0.66 |

## 보류 사례 (학습 샘플 68개 전체로 학습, 처음 보는 사례)

| 사례 | 우리 솔버 RMSE | 평균 편향 보정 | 엑스트라 트리 | 그래디언트 부스팅 |
|---|---|---|---|---|
| holdout_A_normal | 0.44 | 0.25 | 0.05 | 0.09 |
| holdout_B_crac02_06_off | 2.45 | 1.87 | 0.52 | 0.59 |
| holdout_D_crac02_off | 0.75 | 0.39 | 0.36 | 0.38 |
| holdout_E_rm05_06_crac02_06_off | 10.88 | 10.94 | 3.50 | 4.77 |
