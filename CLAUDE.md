# DC-Twin (가상 데이터센터 디지털 트윈) — 포트폴리오 프로젝트

## 목적
Omniverse(OpenUSD 기반 저작·시뮬레이션)와 Unreal Engine 5.8(운영자용 클라이언트)을 역할 분리해 연결한 **공개 가능한 소형 디지털 트윈**을 만든다.
목표 직군은 UE 클라이언트 개발자이며, 시뮬레이션/데이터 직군으로의 확장 가능성을 함께 보여준다.
설계 개요는 `docs/01_architecture.md`, 일정은 `docs/02_roadmap.md`, 비교 실험은 `docs/03_experiments.md`. 문서 전체 목록은 `docs/README.md`.

## 절대 규칙 (회사 자산 분리)
- 이 저장소는 **공개 포트폴리오용**이다. 재직 회사 프로젝트(`D:\UnrealProject\` 아래 업무 프로젝트)의 **코드·에셋·데이터·고객사/내부 명칭을 복사하거나 붙이지 않는다.** 금지어 목록은 저장소에 두지 않고 로컬 파일 `.claude/cleanroom-terms.local.txt`(gitignore)에 둔다.
- 해당 프로젝트는 **읽기 전용 참조**다. 설계 아이디어(계층 구조, 서비스 분리, 배포 절차)만 참고하고 **코드는 새로 작성**한다.
- 모델링은 직접 제작(Blender)한 **가상 시설**만 쓴다. 실제 시설 형상/도면/좌표/로고 금지.
- 시뮬레이션 결과는 "시각화 목적"으로 표기한다. 공학적 정확성을 주장하지 않는다(`docs/04_clean_room_policy.md`). 외부 솔버(FDS, OpenFOAM) 결과는 나중에 같은 격자 `.npy` 형식으로 받는다(방향은 `docs/17_direction_review.md` 머리말에만 있고 ADR로는 아직 쓰지 않았다. ADR-009는 홀 배치와 냉각 방식이다).
- 회사 자산을 참조하는 시험 스크립트는 gitignore된 `experiments/omniverse_probe/local_only/`(및 `out/local_only/`)에만 둔다. 시험용 Unreal 프로젝트는 저장소 밖 `D:\ue_probe\`에 둔다. 상용 도구(외부 CFD 제품 등)로 계산한 결과나 화면은 올리지 않는다.
- 커밋 전에 `git diff --cached`에서 금지어(`.claude/cleanroom-terms.local.txt`)와 업무 머티리얼·파라미터 이름이 0건인지 확인한다(`.claude/skills/clean-room-check`).
- **외부 CFD 도구(Reality DC 등 상용 포함)의 결과·모델 파일(`*.vtk`, `*.vtu`, `*.vti`, `*.room`)과 화면은 저장소, PR, 영상, 문서에 올리지 않는다.** 변환 파이프라인(`sim/sensors/dct_sensors/external`)은 gitignore된 `sim/out/local_only/`에만 쓰고, 결과는 로컬 서버가 줄 때만 화면에 보인다. **Reality DC 사용은 라이선스 확인 전까지 보류**한다(2026-11-04, 사용자 결정). CI(`external_guard.test.js`)가 추적 파일을 검사한다.
- 서버 접근 토큰, `.env` 값은 커밋하지 않고 대화나 로그에 찍지 않는다. 서버를 `127.0.0.1` 밖으로 열면 토큰이 필수다(`server/README.md`).
- `D:\UnrealProject\**`, `D:\omniverse-labs-main\**`는 수정하지 않는다(권한으로도 차단).

## 구조 요약
```
hall01.config.json → build_scene.py → 장면 USD(prim 경로 + dct: 메타데이터)
   → 열 계산: Warp(hall60_sim, L1) + 보정 모델(L2), 기준 답: OpenFOAM(WSL)
   → 서버(sim/sensors, Omniverse Kit 안에서 실행 가능) → WebSocket → 웹 보기 화면(web/viewer)
   → (나중) UE 5.8 클라이언트: USD 임포트 + WebSocket 수신
```
데이터 경로 3종: ① 정적 USD ② 미리 계산한 데이터(녹화, 흐름장) ③ 서버 실시간 값. MQTT와 `gateway/`는 처음 설계의 예제 경로로 남아 있다. 상세는 설계 문서 참조.

## 디렉터리
| 경로 | 내용 |
|---|---|
| `docs/` | 기획·설계·로드맵·실험·정책, `docs/decisions/`(ADR) |
| `blender/` | .blend 원본, 내보내기 스크립트 |
| `usd/` | 내보낸 USD 에셋/씬 (`assets/`, `scenes/`) |
| `sim/` | 센서 시나리오 생성기(`sensors/`), 서버. `thermal/dct_thermal/`에 열 계산(Warp, `hall60_sim.py`)과 보정 모델(`predictor.py`, `residual_model.py`)이 있다(2026-11-13 `experiments/`에서 옮김, 옛 위치에는 같은 모듈을 가리키는 연결 파일만 남음, `docs/30` M12). 시험(`sim/thermal/tests`)과 uv 환경(`sim/thermal/pyproject.toml`)도 여기 있다. OpenFOAM 도구(사례 만들기, 실행, 결과 꺼내기)는 `sim/openfoam/`(2026-11-15 이동, 옛 위치는 연결 파일). 실험 스크립트는 그대로 `experiments/omniverse_probe` 환경 |
| `scripts/usd_tools/` | USD 검증(`validate_usd.py`), 에셋 마무리(`finalize_asset.py`), 장면 생성(`build_scene.py`) |
| `usd/scenes/hall01.config.json` | 홀 배치 원본(랙 6줄 x 10기, CRAC 8기, 열기 통로 격리 HAC + 천장 회수, 작업자 동선이 있는 최종 구조 `docs/35`). 냉기 통로 격리 장면은 `hall01_cac.config.json`(`docs/34`). 장면은 이 파일들에서만 만든다. `_hall01_rf*`는 예전 시험용 |
| `gateway/` | MQTT → WebSocket/REST 게이트웨이 (Node). 예제로만 두고 손대지 않는다(운영 경로는 `server/`, `docs/30` 6절) |
| `unreal/` | UE 5.8 프로젝트 `unreal/DataCenter_DT/DataCenter_DT.uproject` (C++, 모듈 `DataCenter_DT`) |
| `web/viewer/` | 웹 보기 화면(Three.js, Vite). GitHub Pages에 자동 배포. 메뉴: 모니터링 / 시뮬레이션(미리 계산한 값 12개, 서버에 붙으면 조건을 정해 계산) / 간이 계산(브라우저 L0) / CCTV. 녹화는 HAC(`public/data/rec/`)와 CAC(`rec/cac/`) 각 10개. 설명은 `web/viewer/README.md`, 설계는 `docs/27`, 세 메뉴의 역할은 `docs/31`(모니터링=서버 실시간, 시뮬레이션=조건을 정해 서버에서 정확하게, 간이 계산=모니터링 상태에서 팬·급기만 빠르게) |
| `server/` | 시뮬레이션 서버 실행 구성(Docker, compose, `run_local.ps1`, 센서 매니페스트·앵커 사본). 코드는 `sim/sensors/dct_sensors/serve.py`, `api.py`. 인증, 안전, 한계는 `server/README.md`. **Omniverse Kit 안에서 도는 로컬 서버**는 `run_local.ps1 -Kit`(`server/kit_server.py`, 실시간 센서 값과 시뮬레이션 작업. 정확한 계산은 팬 상태별 OpenFOAM 흐름 + Warp 온도 계산, `docs/31`). 배포는 나중 |
| `sim/library.json` | 미리 계산해 두는 상태와 시나리오 정의(이상 상황 4, 급기 온도 5, 부하 3). 생성은 `scripts/make_sim_library.py` |
| `experiments/` | 비교 실험 코드와 측정 결과. `results/`(E·V 결과 문서), `openfoam_baseline/`(OpenFOAM 학습·검증 사례와 결과, `README.md`), `surrogate_model/`(보정 모델 학습·평가, `model*.pkl`은 저장소에 올리지 않음), `omniverse_probe/`(실험 스크립트 환경) |
| `scripts/` | 환경 점검, 실행 보조 스크립트 |

## 컨벤션
- **USD 규칙(v2)**: prim 경로 `/DC/Hall{NN}/Row{NN}/Rack_{NN}/...`, 단위 cm, Up-axis Z, 커스텀 속성 접두 `dct:`. 센서는 장비 아래 `Anchors/Sensor_*` 앵커 prim이고 `dct:sensorId`는 장면에서 붙인다. 홀 아래에는 `Row##`, `Cooling`, `Power`, `Shell`, `Containment`, `Vents`, `Looks`, `Tour`만 둔다. 상세: `docs/09_usd_spec.md`, `.claude/skills/usd-conventions`.
- **홀 장면**: 손으로 고치지 않는다. `usd/scenes/hall01.config.json`을 고치고 `scripts/usd_tools/build_scene.py`를 다시 실행한 뒤 `validate_usd.py`로 검증한다. 나중에 Unreal에서 랙을 옮기고 다시 시뮬레이션하는 흐름을 지원하도록, 시뮬레이션 입력은 장면 USD에서 읽는다(하드코딩 금지).
- **MQTT 토픽**: `dct/v1/{hall}/{asset}/{metric}`(예: `dct/v1/hall01/rack_01/temp_in`), 페이로드는 JSON(`ts`, `value`, `unit`, `quality`). 시나리오 이름은 MQTT에 없고 게이트웨이 재생 입력에서만 온다(`docs/11`).
- **UE C++**: 모듈 `DataCenter_DT`(엔진 매크로 `DATACENTER_DT_API`), 계층 `Core / Data / World / UI / Streaming`. 접두 `DCT`. 새 코드만 작성, 회사 프로젝트 클래스명 재사용 금지.
- **Python**: `uv`로 환경 관리, 3.13 권장(`ovrtx` 휠 호환). 시스템 Python 3.14는 사용하지 않는다.
- **Git 워크플로**(`docs/06_workflow.md`): `main`에서 직접 작업하지 않는다. 작업 시작 시 `feat|fix|docs|chore|exp/<주제>` 브랜치를 먼저 만들고, Conventional Commits로 커밋(`type(scope)`는 영어 키워드, **제목·본문은 한글**: 예 `feat(sim): cooling_failure 시나리오 생성기 추가`), PR → Squash merge. 바이너리는 Git LFS. 커밋·푸시·PR·squash 병합은 사용자가 위임했다(2026-11-02): 규칙을 지키며 알아서 진행하고 CI 통과 뒤 병합한다. force push 금지, `main` 직접 push 금지.

## 문서·용어 규칙
- 다른 개발자가 읽고 인수인계받을 수 있게 쓴다. **쉬운 말을 쓰고, 용어는 `docs/07_glossary_and_writing_rules.md`의 "쓰는 말"로 통일한다.**
- 약어는 처음 나올 때 풀어 쓰고, 어려운 외래어·한자어는 피한다. 새 용어를 만들면 용어집에 추가한다.
- 문서 맨 위에 목적과 상태(초안/채택/폐기)를 적고, 결정에는 이유와 다른 방법을 함께 적는다.
- 응답과 문서에서 "하네스", "클린룸", "스모크 테스트", "베이크"는 용어집 표기("작업 환경 설정", "회사 자산 분리 규칙", "동작 확인 테스트", "미리 계산한 데이터")를 쓴다.

## 검증과 실행 명령
PR 전에 해당하는 것을 돌린다. 하나라도 실패하면 이유를 밝히고 고친다(시험을 약하게 바꾸지 않는다). 전체 순서와 주의는 `.claude/skills/verify-all`.
| 대상 | 명령(폴더) | 시간 |
|---|---|---|
| 웹 단위 시험 | `npx vitest run` (`web/viewer`) | 몇 초 |
| 웹 빌드와 용량 | `npm run build` | 1분 이내 |
| 화면 시험(puppeteer, Edge) | `node tools/ui_check.mjs` (빌드 뒤) | 2~3분(120초 도구 제한을 넘으므로 백그라운드로) |
| 글자 대비 | `node tools/contrast_check.mjs` | 1분 |
| 데이터 정합성 | `node tools/check_data.mjs` | 몇 초 |
| 파이썬 시험 | `uv run --python 3.13 --extra serve python -m pytest tests` (`sim/sensors`) | 1분 |
| Warp 열 계산 시험 | `uv run --python 3.13 python -m pytest tests` (`sim/thermal`, GPU) | 약 6분(도구 제한 120초를 넘으므로 timeout을 늘리거나 백그라운드로) |
| 형상 사본 일치 | `uv run --python 3.13 python ../../scripts/check_geometry.py` (`sim/thermal`, Warp 시험에도 포함) | 몇 초 |
| 실험 스크립트 시험 | `uv run --python 3.13 python -m pytest tests` (`experiments/omniverse_probe`) | 몇 초 |
| 보정 모델 시험 | `uv run --python 3.13 python -m pytest tests` (`experiments/surrogate_model`) | 몇 초 |
| 서버 | `server/run_local.ps1`(GPU L2 또는 `-Solver l0`), Docker는 `server/README.md` | |
주의: 점검용으로 띄운 서버와 브라우저, Kit(`kit.exe`) 프로세스는 끝내고 정리한다. Kit 스크립트는 파일이 있는 상태에서 실행한다(없으면 종료되지 않는다). OpenFOAM은 한 번에 하나만, 여러 사례는 `keepalive.py`로 돌린다(사례당 HAC 약 37분, CAC 약 29분, `verify-all`).

## 작업 방식
- **지금 진행 중인 일**: Kit으로 시뮬레이션 정확도 검증(`docs/32`: V1 물리 점검 → V2 처음 보는 조건 → V3 OpenFOAM 격자 → V4 모델 개선). V1, V2(HAC, 2026-11-27)는 끝났다.
  - **다음 작업(2026-11-27 사용자 결정)**: u09 원인은 확인했다(`experiments/results/V2_unseen_conditions.md` 3.1). OpenFOAM 사례 생성기가 급기 부족(새는 양 > 0)일 때만 냉기 통로 천장 판을 통째로 열어 뜨거운 공기가 약 8 m³/s 내려오는 것이 주된 원인이다. 임시로 L2에 급기 부족이면 `caution` 규칙을 넣었다(`solver_l2.py` `LEAK_CAUTION_M3S`). 다음은 **기준 계산의 냉기 통로 천장을 늘 틈 판(다공질 저항, CAC 지붕 방식)으로 바꾸고**(`sim/openfoam/gen_case.py`), 우리 계산도 같은 판으로 맞춘 뒤 u09·s37·s38을 다시 계산하는 것이다(사례당 약 70분).
  - 그 뒤 후보(사용자가 고를 것): 급기 온도가 18도가 아닐 때 `ok`→`caution` 규칙 풀기(V2 2장 근거), CAC 장면 V2(약 6시간), V3 격자. 그 다음 `docs/31`의 화면 연결. 서버는 Kit 안에서 도는 로컬만(배포는 나중).
- **우선순위**: 가장 중요한 것은 시뮬레이션과 센서 데이터의 연동·표현이다(`docs/14_sim_to_unreal_core.md`). 외관과 둘러보기는 보조다. 진행 순서는 ① 내부 구조 모델링 → ② 그 구조로 시뮬레이션 → ③ 화면에서 확인이다. **2026-11-16부터 Unreal은 후순위다**(사용자: 웹으로 먼저 다 만든다). Unreal 작업(`unreal/.../Content/UsdAssets` 정리 포함)은 사용자가 다시 말할 때 시작한다.
- 단계는 `docs/02_roadmap.md`의 Phase 순서를 따른다. 각 Phase 끝에 산출물과 측정값을 `experiments/` 또는 `docs/`에 남긴다.
- 설계 결정은 `docs/decisions/ADR-XXX-*.md`에 한 장씩 기록한다(결정, 근거, 대안, 한계).
- 외부 도구(Omniverse, UE 플러그인)의 지원 상태는 시기별로 변하므로 **공식 문서로 확인한 날짜와 버전**을 기록한다.
- 환경 점검: `scripts/check_env.ps1`. 결과 기록: `docs/05_env_status.md`.

## 환경 (2026-10-15 확인)
RTX 5090 32GB / Ryzen 9 9950X3D / RAM 126GB / UE 5.8.3(5.7.4, 5.5.4도 설치) / Blender 5.1 / Node, Git, uv, WSL 있음 / Mosquitto 없음. Docker Engine은 WSL Ubuntu 24.04에 설치(29.1.3, 2026-11-04; Docker Desktop은 라이선스 약관 때문에 쓰지 않음, Windows에서는 `wsl -u root -- bash <스크립트>`로 실행. 한 줄 명령은 PowerShell과 WSL의 인용이 엉키므로 스크립트 파일로 쓴다).
Omniverse: Kit SDK 110.4.0 앱 설치·실행 확인(`D:\omniverse-kit\kit-app-template`, 앱 `dctwin.base_editor`), Warp 1.18.0, `ovrtx 0.3.0`, `ovphysx 0.3.7`. 시험 환경은 `experiments/omniverse_probe`(uv, Python 3.13), 결과는 `experiments/results/E0_omniverse_capability_probe.md`.
도구 경로: Blender `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`, GitHub CLI `C:\Users\User\tools\gh-2.102.0\bin\bin\gh.exe`(PATH 미등록). 저장소는 `main` 보호(PR 필수, Squash merge만).
