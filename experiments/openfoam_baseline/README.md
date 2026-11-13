# OpenFOAM 기준 답(reference) 사례

- 목적: 같은 홀, 같은 조건을 OpenFOAM(공기 흐름 + 온도 + 난류)으로 풀어, 우리 열 시뮬레이션(`sim/thermal/dct_thermal/hall60_sim.py`)의 랙 입구 온도와 견줄 수 있게 한다.
- 상태: 초안(동작함). **시각화 목적의 비교이며 공학적 정확성을 주장하지 않는다.** 메시 의존성 시험은 제대로 하지 못했다(아래 "한계").
- 확인한 날짜: 2026-10-16. OpenFOAM v1912 (ESI, Ubuntu 24.04 패키지 `openfoam 1912.200626`), WSL, 16코어 사용.

## 한 줄 요약
같은 칸 나눔(10 cm), 같은 유량, 같은 발열로 돌린 OpenFOAM 값은 **정상 상태에서 우리 솔버와 평균이 0.4도 이내로 맞고**(상관 0.98), **CRAC 2대 정지에서는 우리 솔버가 열 쏠림을 작게 본다**(랙 입구 최대 23.7도 대 30.9도, 줄 끝 평균 22.3도 대 29.1도). 방향(줄 끝이 더 뜨거움)은 같지만 크기가 다르다.

## 파일
| 파일 | 내용 |
|---|---|
| `export_layout.py` | 장면 USD에서 형상을 읽어 `layout.json` 저장(`hall60_sim.read_hall` 사용) |
| `gen_case.py` | 장면에서 OpenFOAM 사례 정의를 만든다(`cases/<이름>/`). 칸 나눔, 유량은 `hall60_sim.Layout`과 `crac_returns`를 읽어 그대로 쓴다 |
| `run_case.sh` | 사례를 WSL 홈(`~/foam_runs/`)으로 복사해 메시 -> 계산 -> 합치기까지 실행 |
| `extract.py` | 결과 필드에서 랙 입구 온도 CSV 추출(WSL의 python3) |
| `restart_lu.sh` | 수렴한 결과에서 이어서 2차 정확도 방식으로 다시 계산 |
| `compare.py` | 우리 솔버와 OpenFOAM 비교 표 |
| `cases/` | 만들어 둔 사례 정의(작은 텍스트, 합계 약 1 MB). 메시와 결과 필드는 저장소에 두지 않음 |
| `results/rack_inlet_{normal,crac02_06_off}.csv` | **기준 결과**(열: rack_id, temp_c). 접미 `_nobuoy`, `_lu`, `_dx20`은 변형, `_front_mean`은 앞면 한 겹 평균 |
| `results/ours_rack_inlet_*.csv` | 같은 조건으로 돌린 우리 솔버 값(`.meta.json`에 hall60_sim.py 해시와 인자 기록) |
| `results/comparison*.md`, `*_summary.json` | 비교 표, 결과 요약(랙 안 속도, 열 수지 포함) |

## 실행 방법
```
# 1) 사례 만들기 (Windows, experiments/omniverse_probe 폴더에서)
uv run --python 3.13 python ../openfoam_baseline/export_layout.py
uv run --python 3.13 python ../openfoam_baseline/gen_case.py --scenario normal --out ../openfoam_baseline/cases/normal_dx10
uv run --python 3.13 python ../openfoam_baseline/gen_case.py --scenario crac02_06_off --out ../openfoam_baseline/cases/crac02_06_off_dx10
# 2) 계산 (WSL). 이 설치는 환경 파일 없이 WM_PROJECT_DIR만 있으면 된다. 코어 수 기본 16
wsl -e bash -lc "bash /mnt/d/Test/experiments/openfoam_baseline/run_case.sh normal_dx10 16"
# 3) 결과 뽑기
wsl -e bash -lc "cd ~/foam_runs/normal_dx10 && python3 /mnt/d/Test/experiments/openfoam_baseline/extract.py . /mnt/d/Test/experiments/openfoam_baseline/results/rack_inlet_normal"
# 4) 비교 (--rerun-ours 면 우리 솔버를 GPU로 다시 돌림)
uv run --python 3.13 python ../openfoam_baseline/compare.py [--rerun-ours] [--of-suffix _nobuoy]
```
옵션: `gen_case.py --dx 0.1 --no-buoyancy --scheme upwind|linearUpwind --power 10 --dflow 2e7`.

## 모델 대응 표
| 우리 솔버 (hall60_sim.py) | OpenFOAM 사례 |
|---|---|
| 격자 10 cm, 110 x 136 x 40 (장면에서 칸 나눔) | **같은 10 cm 격자**. blockMesh 한 덩어리에서 CRAC와 격벽 칸을 `topoSet` + `subsetMesh`로 뺀다. 칸 나눔 규칙(`rng`)을 그대로 써서 격벽 5 cm도 10 cm 한 칸이 된다(snappyHexMesh는 쓰지 않음) |
| 랙: 칸 안 속도 0.8 m/s로 고정, 앞면 흡입 / 뒷면 배출 | 랙 칸을 cellZone으로 만들고 **강한 다공질 저항(Darcy) + 목표 속도에서 저항과 균형을 이루는 일정한 힘**을 건다. 결과 랙 안 속도 평균 0.79~0.80 (최소 0.77, 최대 0.84 m/s) |
| 랙 발열: 랙 칸 전체에 일정하게 (10 kW, 랙 1기당 6.94 K/s) | 같은 영역에 같은 값의 온도 원천항(`scalarSemiImplicitSource`). 평균 앞뒤 온도 차 8.3도(정상) |
| CRAC 회수: 회수면 칸에서 유량 `q_i`만큼 빨아들임 | CRAC 회수면(높이 0.1~1.9 m)을 **속도 고정 출구**(`flowRateInletVelocity`, 음의 유량)로, 유량은 `hall60_sim.crac_returns`와 같은 값 |
| 급기구 30개: 위로 공기를 내보내고 온도 18도 고정 | 바닥 급기구 면을 **속도 입구**(총 유량 = 켜진 CRAC 회수 합, 온도 18도). 급기구 칸 범위도 우리와 같다 |
| 격벽: 막힌 칸 | 벽(`noSlip`, 단열) |
| 격벽 지붕 틈: 용량을 넘는 배기를 지붕 아래 칸에서 위 칸으로 보냄 | **새는 통로(B의 CRAC_02/06 통로)의 지붕 격벽을 없애 열어 둠.** 새는 양은 정하지 않고 흐름이 정한다 |
| 난류 없음, 확산 계수 0.02 m2/s 고정 | k-epsilon(표준), 벽 함수. 물 성질 nu 1.5e-5, Pr 0.71, 난류 Prt 0.85 |
| 부력 없음 | 부력 있음(Boussinesq, beta 3e-3, 기준 18도). `--no-buoyancy` 변형으로 끈 결과도 냄 |
| 이류: 반 라그랑지안(수치 확산 큼) | 기본 1차 풍상(upwind, 수치 확산 큼). 변형으로 2차(linearUpwind, 온도는 limitedLinear) |
| 정해진 시간 응답(`--slow 10`) | **정상 상태**(SIMPLE 반복). 시간 응답은 비교하지 않는다 |

## 우리 모델과 어긋나는 가정 (모두 적는다)
1. **운동량 방정식과 난류가 있다.** 우리는 퍼텐셜 흐름이라 급기 기류가 멀리 뻗지 못하고 관성, 재순환이 없다. 이것이 가장 큰 차이의 원인으로 보인다(추측).
2. **새는 양을 정하지 않았다.** 우리는 지붕 틈으로 새는 양을 "배기 - CRAC 회수"로 강제한다. OpenFOAM은 지붕을 열어 둬서 뜨거운 공기가 부력과 흐름으로 알아서 빠진다. 위로 올라간 공기가 방 위쪽에 고여 다시 랙으로 들어오는 양이 달라질 수 있다.
3. **랙 안 속도는 거의 고정이지만 완전 고정은 아니다**(0.77~0.84 m/s). 랙 안 압력 손실(nu x d x 속도 x 깊이 x 공기 밀도로 약 290 Pa)이 생기며, 우리는 압력 손실이 없다.
4. 랙 전력은 **10 kW 균일**이다(`hall60_sim.py` 기본값; 장면에는 전력 값이 들어 있지 않다. 센서 앵커만 있다).
5. 급기구는 바닥 면에서 위로 3.2 m/s(정상 57.6 m3/s 기준, 면적은 칸 범위 기준)로 나온다. 우리는 세 층(30 cm)의 칸에서 부피 원천으로 내보낸다.
6. 벽은 모두 단열, 바닥 아래 공간, 바닥 틈, 랙 옆면 새는 공기, 케이블 구멍은 없다(우리도 없음).
7. CRAC 회수구 온도는 영 기울기이고, 급기는 CRAC 회수 온도와 무관하게 18도로 고정이다(우리와 같음. CRAC 코일 모델 없음).
8. 우리 솔버의 값은 **시간 응답 끝 시점**(정상: 600초, B: 900초, 300초 이후 변화 없음 확인)이고, OpenFOAM은 정상 상태다. 우리 시간 응답은 `--slow 10` 조절값을 쓴다.
9. **우리 솔버 숫자가 E0 문서(2.18장)와 다르다.** 오늘 `hall60_sim.py`를 그대로 돌려 얻은 B의 값(평균 19.33, 최대 23.68, 줄 끝 22.30 / 가운데 18.59, 가장 뜨거운 랙 21, 30, 50, 41, 11)은 문서의 값(19.98 / 23.44 / 22.4 / 19.4)과 조금 다르다. 파일이 별도로 수정되고 있기 때문으로 보인다(추측). 비교에는 돌린 시점의 파일을 쓰고 해시를 `.meta.json`에 남겼다.

## 결과

> **갱신 2(2026-10-16):** 냉기 통로 윗면 보정(`SIGMA_COLD_TOP` 0.1)을 넣은 우리 솔버의 최신 비교는 `results/comparison_summary_sigma01.md`와 사례별 `comparison_*.md`(우리 값 태그 `_sigma01`)에 있다. `_pr55` 태그 파일은 보정 전(PR #55 직후) 값이다. 변화와 한계는 E0 문서 2.23장.
>
> **갱신(2026-10-16):** 아래 표의 "우리 솔버" 값은 지붕 틈으로 새는 공기가 열을 잃던 문제를 고치기 **전** 값이다. 고친 뒤 값(B: 평균 20.52, 최대 28.89, 줄 끝/가운데 25.34/19.32, RMSE 2.71)은 `results/comparison.md`와 E0 문서 2.21장에 있다. OpenFOAM 값은 그대로다.
센서 앵커(`Sensor_TEMP_IN`, 랙 앞면 5 cm 앞, 높이 1.2 m)가 들어 있는 칸의 온도. 우리 솔버도 같은 칸을 읽는다.

**A 정상**

| 항목 | 우리 솔버 | OpenFOAM | 차이 |
|---|---|---|---|
| 랙 입구 평균 (도) | 18.09 | 18.46 | +0.37 |
| 랙 입구 최대 (도) | 18.13 | 19.89 | +1.76 |
| 줄 끝 랙 평균 / 가운데 평균 (도) | 18.13 / 18.08 | 19.54 / 18.19 | +1.41 / +0.11 |
| 줄 끝 - 가운데 (도) | +0.05 | +1.34 | +1.29 |
| 가장 뜨거운 랙 5기 | 01, 10, 11, 20, 31 | 31, 21, 11, 41, 30 | |
| 랙별 오차 | | RMSE 0.65 도, 편향 +0.37, 상관 0.98 | |

**B CRAC_02 + CRAC_06 정지** (같은 통로의 2대)

| 항목 | 우리 솔버 | OpenFOAM | 차이 |
|---|---|---|---|
| 랙 입구 평균 (도) | 19.33 | 22.18 | +2.84 |
| 랙 입구 최대 (도) | 23.68 | 30.87 | +7.19 |
| 줄 끝 랙 평균 / 가운데 평균 (도) | 22.30 / 18.59 | 29.13 / 20.44 | +6.83 / +1.85 |
| 줄 끝 - 가운데 (도) | +3.71 | +8.69 | +4.98 |
| 가장 뜨거운 랙 5기 | 21, 30, 50, 41, 11 | 51, 01, 60, 31, 11 | |
| 랙별 오차 | | RMSE 3.83 도, 편향 +2.84, 상관 0.86 | |

참고(추측): OpenFOAM에서 가장 뜨거운 랙에 51, 01, 60이 들어간 것은 바깥쪽 줄 끝이다. 열린 지붕으로 올라간 뜨거운 공기가 방 전체에 퍼진 영향일 수 있으나 확인하지 않았다. 우리 솔버는 같은 통로 옆 줄(21, 30, 41, 50)만 뜨거워진다.

**변형 결과(OpenFOAM, 랙 입구 평균 / 최대 / 줄 끝 평균 / 가운데 평균)**

| 변형 | A 정상 | B CRAC 2대 정지 | 비고 |
|---|---|---|---|
| 기본(10 cm, upwind, 부력 있음) | 18.46 / 19.89 / 19.54 / 18.19 | 22.18 / 30.87 / 29.13 / 20.44 | 수렴 |
| 부력 끔 | 18.45 / 19.77 / 19.46 / 18.20 | 22.46 / 31.18 / 29.83 / 20.62 | 수렴. 부력은 이 조건에서 영향이 작다 |
| 2차 방식(linearUpwind) | 18.36 / 19.77 / 19.58 / 18.05 | 21.92 / 30.93 / 29.37 / 20.05 | 둘 다 **수렴 기준 못 채움**(A: 5000회, B: upwind 결과에서 2500회 더). 값은 거의 안 움직임 |
| 거친 격자(20 cm) | 18.79 / 23.06 / 21.26 / 18.17 | 21.47 / 29.31 / 26.78 / 20.15 | A는 4000회에서도 수렴 못 함. 랙 크기가 20 cm 격자에 안 맞음(아래) |
| 앞면 한 겹 평균(기본 결과의 다른 읽기) | 18.46 / 19.48 / 19.34 / 18.24 | 22.85 / 28.04 / 27.21 / 21.76 | 한 칸 값보다 최대가 낮고 가운데가 높음 |

수렴 기준과 횟수(초기 잔차가 모두 이하일 때 종료): p_rgh 1e-4, U 1e-5, T 1e-6, k와 epsilon 1e-5. 열 수지 점검: 랙 발열 600 kW에 대해 CRAC 회수구로 나가는 열이 정상 603 kW, B 589 kW(차이 2% 이내).

## 계산 시간
메시 573,600칸(정상, B는 574,500칸), 16코어(WSL, 32스레드 컴퓨터), 케이스 하나씩 순서대로 실행.

| 사례 | 반복 | 벽시계 | 비고 |
|---|---|---|---|
| A 정상 (10 cm) | 1077 | 450초 + 메시 8초 | 수렴 |
| B 정지 (10 cm) | 1776 | 672초 + 메시 8초 | 수렴 |
| A 부력 끔 / B 부력 끔 | 1035 / 1691 | 350 / 597초 | 수렴 |
| A 2차 방식 | 5000 | 1679초 | 수렴 못 함 |
| B 2차 방식 | 1776에서 +2500 | 878초 | 수렴 못 함 |
| A / B (20 cm) | 4000 / 747 | 74 / 13초 | |

참고: 우리 솔버는 같은 시나리오를 약 18초(GPU, 900초 시뮬레이션)에 푼다. 같은 컴퓨터에서 두 사례를 동시에 돌리면 코어가 겹쳐 20배 넘게 느려졌다(순서대로 돌릴 것). 5 cm 격자(463만 칸)는 반복 1회에 약 10초라 3000회에 8시간 이상 걸려서 중단했다(결과 없음).

## 한계
- **메시 의존성은 제대로 못 봤다.** 10 cm와 20 cm만 있고, 20 cm에서는 B 평균 -0.7도, 줄 끝 평균 -2.4도, 최대 -1.6도로 값이 움직인다. 20 cm는 랙 폭 60 cm가 칸에 안 맞아(4칸 = 80 cm로 반올림) 순수한 격자 효과가 아니다. 5 cm는 시간이 너무 걸려 못 했다. 따라서 10 cm 결과의 격자 오차를 모른다. 1차 풍상 + 10 cm는 수치 확산이 클 것이다(추측).
- 2차 방식(linearUpwind)은 수렴 기준을 못 채웠다(진동). 값은 크게 안 움직였지만 완전한 확인은 아니다.
- 난류 모델(k-epsilon)과 벽 함수, 급기구 난류 조건(세기 5%, 혼합 길이 5 cm)은 검증 없이 기본값에 가깝게 썼다. 다른 난류 모델 비교 없음.
- 랙 입구 온도 한 칸 값은 위치와 높이에 민감하다(B에서 한 칸 값과 앞면 평균의 최대가 30.9도 대 28.0도). 그래서 앞면 평균 파일도 같이 남겼다.
- 실제 장비 데이터나 측정과 비교하지 않았다. 이 값은 "다른 계산법으로 풀면 이 정도 차이가 난다"를 보는 용도다.
- 이 설치(Ubuntu 패키지)는 `probes`, `postProcess`가 `sha1` 오류로 죽어서, 결과 필드를 직접 읽는다(`extract.py`). 칸 순서가 메시와 일치하는 것은 랙 영역 칸 번호로 확인했다(10 cm 격자에서 일치).
- `fvOptions`의 `vectorSemiImplicitSource`에서 Sp를 음수로 주면 발산해서(명시적으로 처리됨) Sp 없이 저항(Darcy)과 균형 힘으로 바꿨다.

## 용량과 설치
- 저장소에 두는 것: 이 폴더 약 1.6 MB(사례 정의 약 1 MB, 결과 CSV와 우리 솔버 출력). 우리 솔버 출력 폴더 `results/ours_*`에 단면 그림(png)이 들어 있어 필요 없으면 지워도 된다.
- 저장소 밖: `~/foam_runs/`(WSL) 350 MB x 사례 수(총 약 3 GB, 5 cm 시험 776 MB 포함). 필요 없으면 `rm -rf ~/foam_runs`.
- 추가 설치 없음(apt 패키지 설치 없음). `~/foam_runs` 외에 WSL, Windows 환경은 바꾸지 않았다.

## 검증 사례 C, D, E (우리 솔버 PR #55 이후 코드, 2026-10-16)
한 사례에만 맞추는 과적합을 피하려고 다른 조건 3개를 기준 사례와 같은 설정(랙 10 kW, 10 cm, upwind, 부력 켬)으로 더 돌렸다. 기준 사례(A, B)의 OpenFOAM 결과는 그대로이고, **우리 솔버 값만 PR #55 이후 코드로 새로 계산**했다(`results/ours_rack_inlet_*_pr55.csv`, 옛 값 파일은 그대로). 위의 "결과" 표의 우리 솔버 값은 PR #55 이전 코드 기준이다.

- C: CRAC_03 + CRAC_07 정지(통로 2의 두 대). **주의: 이 홀은 y 방향으로 좌우 대칭이라 C는 B(통로 1)의 거울상이다.** OpenFOAM 통계가 B와 소수 둘째 자리까지 같게 나온 것은 사례 설정과 풀이가 대칭을 지킨다는 확인이지, B와 독립인 검증이 아니다.
- D: CRAC_02 한 대 정지(남은 CRAC_06이 용량으로 감당, 새는 양 9.6 m3/s). 약한 고장.
- E: 랙 5, 6번을 장면에서 뺀 편집 장면(`layout_whatif.apply_edits`, 원본 장면은 수정하지 않고 임시 폴더에 둠)에서 CRAC_02 + 06 정지. 랙 58기. 급기 유량은 우리 솔버와 같은 규칙으로 냉기 통로별로 랙 유량 비율에 따라 나눈다(`gen_case.py`가 통로별 급기구 면을 따로 만든다. 기준 사례는 세 통로의 랙 수가 같아 이 규칙이 결과에 영향이 없다).

| 사례 | 평균 | 최대 | 줄 끝 평균 | 가운데 평균 | 끝-가운데 | RMSE | 편향 | 상관 | 가장 뜨거운 5기 (우리 / OpenFOAM) |
|---|---|---|---|---|---|---|---|---|---|
| A 정상 | 18.09 / 18.46 | 18.13 / 19.89 | 18.13 / 19.54 | 18.08 / 18.19 | +0.05 / +1.34 | 0.65 | +0.37 | 0.98 | 01,10,11,20,31 / 31,21,11,41,30 |
| B CRAC_02+06 정지 | 20.52 / 22.18 | 28.89 / 30.87 | 25.34 / 29.13 | 19.32 / 20.44 | +6.02 / +8.69 | 2.71 | +1.65 | 0.84 | 30,21,11,20,50 / 51,01,60,31,11 |
| C CRAC_03+07 정지 (B의 거울상) | 20.52 / 22.18 | 28.90 / 30.87 | 25.34 / 29.13 | 19.32 / 20.44 | +6.02 / +8.69 | 2.71 | +1.65 | 0.84 | 31,40,41,50,20 / 01,51,10,21,41 |
| D CRAC_02 한 대 정지 | 18.19 / 19.88 | 19.30 / 28.27 | 18.64 / 25.93 | 18.08 / 18.37 | +0.56 / +7.56 | 3.34 | +1.68 | 0.82 | 30,21,11,20,50 / 01,51,11,31,21 |
| E 랙 5, 6 제거 + CRAC_02+06 정지 (58기) | 21.16 / 22.19 | 29.56 / 30.50 | 26.43 / 29.19 | 19.78 / 20.36 | +6.66 / +8.82 | 2.21 | +1.03 | 0.87 | 30,21,11,20,50 / 51,01,31,11,21 |

(각 칸은 "우리 솔버 / OpenFOAM", 단위 도. 사례별 자세한 표는 `results/comparison_<사례>.md`, 요약은 `results/comparison_summary_pr55.md`.)

읽는 법(추측 포함):
- 정상(A), 약한 고장(D)에서 우리 솔버는 열 쏠림을 거의 못 만든다. D는 OpenFOAM 최대 28.3도 대 우리 19.3도로 가장 크게 어긋난다. OpenFOAM에서는 고장 통로 쪽 줄 끝(01, 51 등)이 뜨거워지는데, 우리는 용량으로 감당된다고 보고 새는 양만 9.6 m3/s로 두기 때문으로 보인다(확인하지 않음).
- 강한 고장(B, C, E)에서는 평균이 1~1.7도, 최대가 1~2도 낮게 나오고 줄 끝 대 가운데 차이는 우리가 작게 본다(6.0 대 8.7). 가장 뜨거운 랙 5기의 목록은 우리와 OpenFOAM이 거의 겹치지 않는다. 방향(줄 끝이 더 뜨거움)만 일치한다.
- 랙을 뺀 E에서 우리 솔버의 변화 방향(평균 +0.63도, 최대 +0.67도 올라감)은 OpenFOAM(평균 +0.01도, 최대 -0.37도)과 다르다. 랙을 뺀 효과는 둘 다 작아서 이 해상도에서 신뢰할 수 있는 차이인지 모른다.
- 사례 수가 적고(독립 조건은 사실상 A, B, D, E) OpenFOAM 값에도 격자 오차가 있으므로("한계" 참고) 이 표를 우리 솔버의 정확도 측정으로 읽지 말 것.

계산 시간(16코어, 순서대로 실행, 574,500칸, 모두 수렴 기준 충족):

| 사례 | 반복 | 벽시계 | 열 수지(랙 발열 대 CRAC로 나가는 열) | 랙 안 속도 평균 |
|---|---|---|---|---|
| C | 1775 | 609초 + 메시 9초 | 600 대 589 kW | 0.790 m/s |
| D | 1317 | 451초 + 메시 7초 | 600 대 593 kW | 0.792 m/s |
| E | 1849 | 634초 + 메시 5초 | 580 대 570 kW | 0.791 m/s |

### 새 사례 실행 방법
```
# (experiments/omniverse_probe 폴더에서) 사례 만들기: 정지 목록과 장면 경로를 자유롭게 지정
uv run --python 3.13 python ../openfoam_baseline/gen_case.py --fail CRAC_03,CRAC_07 --out ../openfoam_baseline/cases/crac03_07_off_dx10
uv run --python 3.13 python ../openfoam_baseline/gen_case.py --fail CRAC_02 --out ../openfoam_baseline/cases/crac02_off_dx10
uv run --python 3.13 python -c "import layout_whatif as lw, pathlib; lw.apply_edits(pathlib.Path('../../usd/scenes/hall01.usda').resolve(), pathlib.Path('<임시 폴더>/scene_rm0506.usda'), {'remove':['Rack_05','Rack_06']})"
uv run --python 3.13 python ../openfoam_baseline/gen_case.py --fail CRAC_02,CRAC_06 --scene <임시 폴더>/scene_rm0506.usda --out ../openfoam_baseline/cases/rm05_06_crac02_06_off_dx10
# 계산은 반드시 순서대로(동시에 돌리면 20배 이상 느려짐). 사례 끝마다 결과를 뽑아 results/에 저장
wsl -e bash -lc "bash /mnt/d/Test/experiments/openfoam_baseline/run_many.sh crac03_07_off_dx10 crac02_off_dx10 rm05_06_crac02_06_off_dx10"
wsl -e bash -lc "bash /mnt/d/Test/experiments/openfoam_baseline/collect.sh crac03_07_off_dx10 crac02_off_dx10 rm05_06_crac02_06_off_dx10"
# 비교 (우리 솔버를 현재 코드로 다시 돌려 results/ours_*_pr55 에 저장)
uv run --python 3.13 python ../openfoam_baseline/compare.py --rerun-ours --scenarios normal crac02_06_off crac03_07_off crac02_off rm05_06_crac02_06_off
```
`gen_case.py`는 이제 `case_layout.json`(그 사례의 랙 목록)을 사례 폴더에 넣고, `extract.py`가 그것을 읽는다. `compare.py`의 E 사례는 편집 장면을 시스템 임시 폴더에 만들고 끝나면 남기지 않는다.
참고: WSL의 `.sh` 파일은 줄바꿈이 LF여야 한다(CRLF면 사례 폴더 이름 끝에 `\r`이 붙어 조용히 실패한다).

## AI 대리 모델 1단계용 학습 데이터 (`surrogate/`, 2026-10-21)
목적: 우리 솔버의 오차를 배우는 잔차 모델의 학습 데이터. 40개 샘플(CRAC 팬 레벨, 줄별 전력 6~14 kW, 제거한 랙)에 대해 OpenFOAM(10 cm, upwind, k-epsilon, 부력 켬)과 우리 솔버(현재 main)의 랙 입구 온도를 같은 조건으로 얻는다. 보류(hold-out) 평가용으로 기존 A, B, D, E를 `holdout:true`로 표시했다(OpenFOAM 값은 기존 `results/rack_inlet_*.csv`).

| 파일 | 내용 |
|---|---|
| `surrogate/design_samples.py` | 시드 고정(20261021)으로 샘플 설계 + 유량 점검 -> `surrogate/samples.json` |
| `surrogate/make_cases.py` | 샘플별 OpenFOAM 사례 정의(`--out-dir`로 정한 폴더의 `<id>/`, 약 7 MB) 생성. 폴더는 장면마다 다르다: 이중 바닥 전 `cases`, 기본 장면 `cases_rf`, CAC `cases_cac`(`--scene`). `gen_case.py --spec --sample --conservative` 사용. **저장소에는 올리지 않는다**(`surrogate/.gitignore`, 명세에서 다시 만들 수 있다) |
| `surrogate/run_batch.py`, `start_batch.sh` | WSL에서 샘플을 하나씩 순서대로 계산(nice 5, 16코어, 반복 한도 3500), 끝난 샘플은 건너뛰어 이어서 실행 가능, 결과 필드는 삭제 |
| `surrogate/keepalive.py` | Windows 쪽 감독 프로그램. WSL2 가상 머신이 유휴로 내려가 계산이 죽는 것을 막고, 죽으면 다시 시작 |
| `surrogate/ours_batch.py` | 학습 샘플과 보류 4개를 우리 솔버로 계산(`--res` 폴더의 `ours_<id>.csv`, `--scene`으로 장면). 결과 폴더: 이중 바닥 전 `results/surrogate`, 기본 장면 `results/surrogate_rf`, CAC `results/surrogate_cac` |
| `results/surrogate/of_<id>.csv`, `progress.json`, `log_<id>.txt` | OpenFOAM 랙 입구 온도(제거한 랙은 행 없음), 진행 상황(상태, 반복, 시간, converged), 로그 일부 |

실행: (1) `design_samples.py`, `make_cases.py` (experiments/omniverse_probe 폴더에서 `uv run --python 3.13 python ../openfoam_baseline/surrogate/...`), (2) `ours_batch.py`(`make_cases`, `run_batch`, `ours_batch` 모두 폴더 인자가 필수다. 기본값이 옛 장면 폴더를 가리켜 섞일 수 있어 2026-11-13에 없앴다), (3) 무인 계산: `python surrogate/keepalive.py`를 Windows에서 분리 실행(`creationflags=DETACHED|NEW_PROCESS_GROUP|BREAKAWAY`).
조건: 우리 솔버는 처음 120초는 팬 1.0, 10 kW 균일이고 121초부터 샘플의 팬, 전력을 적용해 정상(변화 없음)은 600초, 나머지는 900초까지 돌린 값이다(`compare.py`와 같음). 샘플 명세로 만든 사례 하나가 기존 B와 같은 값을 내는 것을 확인했다(아래).

알아 둘 점:
- 줄별 전력이 다르면 기존 이완 설정(U 0.7)에서 27회에서 발산(FPE)했다. 생성기의 전력 반영은 맞았다(랙별 발열률 확인). 배치 사례는 `--conservative`(U 0.5, p_rgh 0.2, k/epsilon 0.5, T 0.8)를 쓰고, 압력 잔차 기준을 1e-3으로 완화한다(1e-4에서 4e-4로 멈춤). 이 설정으로 B와 같은 조건을 돌리면 기존 B와 랙별 최대 차이 0.053도, 평균 22.177 대 22.178도였다.
- 새는 양이 작아도(예: 0.3 m3/s) OpenFOAM은 해당 통로 지붕을 전부 열어 두므로 부력 교환 흐름이 커질 수 있다. 팬 저하 샘플(s29~s34)과 일부 랙 제거 샘플(s37, s38)이 해당한다.
- CRAC 한 대 고장 샘플 중 통로 0, 3의 CRAC(01, 04, 05, 08)는 남은 한 대가 용량으로 감당해서 유량이 정상과 같다(s05, s08, s09, s12, s13, s14). 유량 분포만 다르다.
- WSL2는 유휴 약 1분 뒤 가상 머신이 내려가면서 `nohup`으로 띄운 계산도 죽는다. 작업 스케줄러나 `Start-Process`로 띄운 `wsl.exe`도 몇 초~몇십 초 뒤 죽었다. `keepalive.py`는 20초마다 짧은 `wsl` 명령을 보내 이를 피한다.
