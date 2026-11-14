# sim/openfoam — OpenFOAM 도구 (사례 만들기, 실행, 결과 꺼내기)

- 상태: 채택 (2026-11-15). `experiments/openfoam_baseline`에 있던 도구를 옮겼다(`docs/30` M12).
- 시각화 목적의 비교용이다. 공학적 정확성을 주장하지 않는다. OpenFOAM은 우리가 WSL에서 직접 돌리는 공개 도구다.

| 파일 | 내용 | 어디서 도나 | 쓰는 곳 |
|---|---|---|---|
| `gen_case.py` | 장면 USD에서 OpenFOAM 사례 정의(메시, 경계, 랙 원천항)를 만든다. 우리 계산(`dct_thermal.hall60_sim`)과 같은 칸 나눔, 같은 유량 | Windows, `sim/thermal` uv 환경 | 정확한 시뮬레이션 작업(`precise.py`), 학습 샘플(`experiments/openfoam_baseline/surrogate/make_cases.py`) |
| `run_case.sh` | 사례를 WSL 홈(`~/foam_runs/<이름>`)에 복사 → 메시 → 계산 → 마지막 시각 모으기 | WSL bash | `precise.py`, 실험 배치 |
| `extract.py` | 결과에서 랙 입구 온도, 앞면 평균, 요약(열 수지, 풍속)을 뽑는다 | WSL `python3`(numpy) | 학습 배치(`surrogate/run_batch.py`), 실험 |
| `export_flow.py` | 결과의 속도, 온도, 난류 점성을 우리 격자 배열(`.npz`)로 옮긴다 | WSL `python3`(numpy) | `precise.py`, 웹 흐름장 만들기 |

## 쓰는 법

```
# 사례 만들기 (sim/thermal 폴더에서)
uv run --python 3.13 python ../openfoam/gen_case.py --spec <샘플.json> --out <사례 폴더>/<이름>
# 실행 (사례 폴더들이 있는 곳을 세 번째 인자로. 없으면 experiments/openfoam_baseline/cases)
wsl -e bash -lc "bash /mnt/d/Test/sim/openfoam/run_case.sh <이름> 16 <사례 폴더들이 있는 곳(WSL 경로)>"
# 결과 꺼내기 (WSL)
python3 /mnt/d/Test/sim/openfoam/extract.py ~/foam_runs/<이름> <결과 접두>
```

- 옛 위치(`experiments/openfoam_baseline/gen_case.py`, `run_case.sh`, `extract.py`, `export_flow.py`)는 이 파일을 부르는 연결 파일이다. 예전 명령, 실험 배치, `import gen_case`가 그대로 동작한다. 옛 `run_case.sh`는 예전처럼 그 폴더의 `cases/`를 쓴다.
- 남은 의존: 학습 샘플의 랙 제거(`--spec`의 `remove`)는 실험 도구 `experiments/omniverse_probe/layout_whatif.py`를 쓴다. 정확한 시뮬레이션 작업은 랙을 빼지 않으므로 쓰지 않는다. `extract.py`가 사례 안의 `case_layout.json`이 없을 때 읽는 기본 형상은 `experiments/openfoam_baseline/layout.json`(형상 사본, `scripts/check_geometry.py`가 검사)이다.
- 결과 해석과 검증 기록은 `experiments/openfoam_baseline/README.md`, `docs/32`, `docs/33`, `docs/34`.
