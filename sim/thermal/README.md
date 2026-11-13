# sim/thermal — 열 계산과 보정 모델 (`dct_thermal`)

- 상태: 채택 (2026-11-13). `experiments/`에 있던 코드를 옮겼다(`docs/30` M12).
- 시각화 목적이다. 공학적 정확성을 주장하지 않는다.

| 모듈 | 내용 | 쓰는 곳 |
|---|---|---|
| `dct_thermal/hall60_sim.py` | 홀 열 계산(Warp): 장면 USD 읽기, 공기 흐름(퍼텐셜), 온도 이류·확산, 센서 앵커 값 | 센서 생성기 L1/L2(`sim/sensors`), 정확한 계산(`precise.py`), Kit 서버, 실험 스크립트 |
| `dct_thermal/predictor.py` | 보정 모델(잔차 모델) `ResidualPredictor`: 학습, 예측, 90 % 구간, 신뢰 등급 | L2 |
| `dct_thermal/residual_model.py` | 보정 모델의 특징 만들기, 학습 데이터 읽기, 교차 검증 | `predictor.py`, 학습·평가 스크립트 |

## 쓰는 법

- 제품 코드는 `sim/thermal`을 `sys.path`에 넣고 `from dct_thermal import hall60_sim`처럼 가져온다.
- 옛 위치(`experiments/omniverse_probe/hall60_sim.py`, `experiments/surrogate_model/predictor.py`, `residual_model.py`)는 같은 모듈 객체를 돌려주는 연결 파일이다. `import hall60_sim`을 쓰는 실험 스크립트, 옛 모듈 이름으로 저장된 `model.pkl`이 그대로 동작한다. `python hall60_sim.py ...`처럼 명령줄로 실행해도 같다.
- 경로 기준: `hall60_sim.ROOT`는 저장소 루트, `hall60_sim.HERE`(실험 출력 기준)는 `experiments/omniverse_probe`, `residual_model.HERE`(모델 파일)는 `experiments/surrogate_model`이다. 옮기기 전과 같은 폴더에 쓰고 읽는다.

## 실행 환경과 시험

- 필요한 패키지(Warp, usd-core, scipy, pillow, scikit-learn)는 아직 `experiments/omniverse_probe`의 uv 환경에 있다. 시험도 그 폴더에서 돌린다: `uv run --python 3.13 python -m pytest tests`(Warp), `experiments/surrogate_model`에서 `uv run --python 3.13 python -m pytest tests`(보정 모델).
- 남은 일: 시험과 uv 환경을 이 폴더로 옮기기, OpenFOAM 도구(`experiments/openfoam_baseline`)의 제품 경로 정리.
