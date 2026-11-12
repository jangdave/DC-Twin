# DC-Twin

가상 데이터센터의 **디지털 트윈**을 만드는 개인 포트폴리오 프로젝트입니다.
센서 값과 열·기류 데이터를 만들어 내고, 운영자가 보는 화면(운영 화면)을 Unreal Engine 5.8로 구현합니다.

> 모든 3D 모델과 데이터는 직접 만든 가상 시설입니다. 시뮬레이션은 화면에 보여 주기 위한 용도이며, 공학적으로 정확하다고 주장하지 않습니다.

## 한눈에 보기
```
Blender로 모델링 → USD 파일 → Omniverse(데이터 생성)  ┐
센서 값 생성기(Python) → MQTT → 게이트웨이 → WebSocket ┴→ Unreal 운영 화면 → 브라우저(Pixel Streaming)
```
쉬운 설명은 [용어집](docs/07_glossary_and_writing_rules.md)에 있습니다.

## 현재 상태
- 완료: USD 모델(랙 60기 홀, 건물 외관과 내부, 센서 204개), 열·기류 시뮬레이션 시험, 센서 값 생성기, 게이트웨이, Unreal 데이터 계층(연결, 센서 목록, 알람 모델)
- 진행 중: **Unreal 운영 화면**(랙 입구 온도 색 표시는 만들었고, 알람 목록·센서 상세·추이 그래프는 아직 없음)
- 이후: Pixel Streaming과 exe 패키징, 데모 영상. 방향 검토는 [17 방향 검토](docs/17_direction_review.md)
- 진행 상황은 [Milestone](https://github.com/jangdave/DC-Twin/milestones)과 [Issue](https://github.com/jangdave/DC-Twin/issues)에서 볼 수 있습니다.

## 처음 시작하기
필요한 것: Windows, NVIDIA RTX GPU, Unreal Engine 5.8(5.8.3에서 확인), Blender 5.1, Git, Git LFS, `uv`(Python 환경 도구).

1. 저장소를 받습니다.
   ```
   git clone https://github.com/jangdave/DC-Twin.git
   cd DC-Twin
   git lfs install
   ```
2. 개발 환경을 점검합니다. 설치하거나 바꾸는 것은 없고, 무엇이 있고 없는지만 보여 줍니다.
   ```
   .\scripts\check_env.ps1
   ```
3. 동작 확인 테스트를 실행합니다.
   ```
   cd experiments\p1_ovrtx_smoke
   uv run --python 3.13 python smoke_test.py
   ```
   처음 실행은 셰이더 캐시를 만드느라 1~2분 걸릴 수 있습니다.

## 폴더 안내
| 폴더 | 내용 |
|---|---|
| `docs/` | 설계, 계획, 실험, 규칙 문서 |
| `docs/decisions/` | 설계 결정 기록(왜 이렇게 정했는지) |
| `blender/` | Blender 원본 파일과 내보내기 스크립트 |
| `usd/` | 만들어 둔 USD 에셋과 장면 |
| `sim/` | 센서 값과 열·기류 데이터 생성 코드 |
| `gateway/` | MQTT를 WebSocket으로 바꿔 주는 중간 프로그램. **예제로만 둔다**(운영 경로는 `server/`의 시뮬레이션 서버, `docs/30` 6절 결정) |
| `unreal/` | Unreal 프로젝트 |
| `web/` | 웹으로 만드는 일부 화면 |
| `experiments/` | 비교 실험 코드와 결과 |
| `scripts/` | 점검·실행 보조 스크립트 |

## 문서 읽는 순서
1. [전체 구조](docs/01_architecture.md)
2. [단계별 계획](docs/02_roadmap.md)
3. [비교 실험 계획](docs/03_experiments.md)
4. [설계 재점검](docs/08_design_review.md): 문제와 결정, 정하지 않은 것
5. 세부 설계: [USD 규격](docs/09_usd_spec.md), [모델링 가이드](docs/10_modeling_guide.md), [데이터 규격](docs/11_data_spec.md), [Unreal 설계](docs/12_unreal_design.md), [Omniverse 연구 계획](docs/13_omniverse_research.md), **[핵심 설계: 시뮬레이션·센서 데이터의 Unreal 연동과 표현](docs/14_sim_to_unreal_core.md)**
6. [설계 결정 기록](docs/decisions/)
7. [작업 방식(브랜치·커밋·PR)](docs/06_workflow.md)
8. [회사 자산 분리 규칙](docs/04_clean_room_policy.md)
9. [환경 상태](docs/05_env_status.md)
10. [용어집과 문서 작성 규칙](docs/07_glossary_and_writing_rules.md)

## 작업 방식 요약
- `main`에서 직접 작업하지 않고, 브랜치를 만들어 작업한 뒤 PR로 합칩니다(Squash merge).
- 커밋 제목은 `type(scope): 한글 요약` 형식입니다. 예: `feat(sim): cooling_failure 시나리오 생성기 추가`
- 자세한 내용은 [작업 방식 문서](docs/06_workflow.md)를 봅니다.
