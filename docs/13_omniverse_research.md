# 13. Omniverse 연구 계획

- 상태: 초안 v1 (2026-10-15)
- 목적: 시뮬레이션과 데이터 생성을 Omniverse 기반으로 하기로 한 결정([ADR-006](decisions/ADR-006-omniverse-based-simulation.md))에 따라, **무엇을 어떻게 연구하고 어디에 쓸지** 정한다.
- 읽는 사람: 이 프로젝트의 Omniverse 관련 작업을 이어받는 사람
- 관련 문서: [01 구조](01_architecture.md), [08 설계 재점검](08_design_review.md), [11 데이터 규격](11_data_spec.md)

## 1. 확인한 사실 (2026-10-15 웹 검색 기준)

공식 문서와 검색 결과를 요약한 것이다. **검색 결과를 읽은 것이지 직접 설치해서 확인한 것이 아니다.** 직접 확인한 항목은 "확인 상태" 열에 표시한다.

| 항목 | 내용 | 확인 상태 |
|---|---|---|
| Kit SDK | Kit 앱 개발 기반. Kit App Template이 Kit SDK 패키지에 포함되어 있다. 2026년 기준 Windows 패키지(PB 26h1)가 NVIDIA NGC에 있다. | 웹으로만 확인 |
| Kit와 RTX 5090 | 문서에서는 확인하지 못했다. **직접 실행해서 확인했다:** Kit 110.4.0이 RTX 5090(드라이버 616.92)에서 실행되고 RTX 뷰포트, OmniGraph, Warp(Kit 안에서 GPU 커널 실행), PhysX 확장이 동작한다. | **직접 확인** (R1 성공, 2026-10-15) |
| ovrtx / ovphysx | Python 라이브러리. ovrtx는 Python 3.10~3.13 지원. 첫 실행에서 셰이더를 만드느라 1~2분 걸린다. | **직접 확인**(ovrtx 0.3.0이 5090에서 렌더됨) |
| ovstage | ovrtx와 함께 쓰는 별도 패키지. 최신 방식은 `ovstage`로 장면을 열고 다룬다. ovrtx 0.4부터 기존 방식(렌더러가 장면을 직접 소유)은 사용을 권장하지 않는다. | 웹으로만 확인. **우리 동작 확인 테스트는 기존 방식** |
| ovrtx 센서 | 카메라, 라이다, 레이더와 센서 처리 그래프를 지원한다고 문서에 나온다. | 웹으로만 확인 |
| Omniverse Flow | 연기와 불을 그리는 유체 시뮬레이션. Kit 확장(`omni.flowusd`)으로 제공된다. **Kit 110.4.0에서 확장이 켜지고 `Fire` 프리셋의 OpenVDB 내보내기(연기, 온도, 속도)가 실제로 동작한다.** USD에 `FlowEmitterNanoVdb`(NanoVDB를 발생원으로)와 `FlowSparseNanoVdbExportParams` 스키마가 있다. 다만 용량이 매우 크고(프레임당 3채널 약 31MB) 내보내는 동안 속도가 약 10배 떨어진다. | **직접 확인**(내보내기). 우리 장면 연결과 Unreal 읽기는 미확인 (R2 부분 성공) |
| NVIDIA Warp | GPU에서 도는 Python 시뮬레이션 프레임워크. `wp.Volume`으로 NanoVDB 부피 데이터를 다루고 `.nvdb`로 저장한다(zip 압축 지원). 문서에 OpenVDB(`.vdb`) 쓰기는 없다. **Warp 1.18.0이 RTX 5090(sm_120)에서 동작하고 Kit 안에서도(Warp 1.17.0) 동작한다.** USD 장면에서 읽은 형상으로 열 시뮬레이션과 가상 센서를 만들었다. | **직접 확인** (R5 중간 결과) |
| DSX Blueprint | NVIDIA의 AI 데이터센터 디지털 트윈 참고 구현. OpenUSD 기반이고 **열(CFD 열기 통로 시뮬레이션)과 전기 부하 시뮬레이션**을 포함한다. Kit 앱, 스트리밍 서버, 웹 프런트엔드로 구성된다. 문서는 "바로 쓸 수 있는 제품이 아니라 확장해서 쓰는 예제"라고 밝힌다. | 웹으로만 확인. 참고 자료로 쓴다 (연구 R3) |

**출처**
- [Kit App Template (GitHub)](https://github.com/NVIDIA-Omniverse/kit-app-template), [Kit SDK 개요](https://docs.omniverse.nvidia.com/kit/docs/kit-app-template/latest/docs/kit_sdk_overview.html), [Kit SDK Windows PB 26h1 (NGC)](https://catalog.ngc.nvidia.com/orgs/nvidia/omniverse/resources/kit-sdk-windows-pb26h1/-)
- [ovrtx 시작하기](https://nvidia-omniverse.github.io/ovrtx/python_api/getting_started.html), [ovrtx (PyPI)](https://pypi.org/project/ovrtx/)
- [Omniverse Flow 개요](https://docs.omniverse.nvidia.com/kit/docs/flow/latest/overview.html), [Flow 설정(내보내기)](https://docs.omniverse.nvidia.com/extensions/latest/ext_fluid-dynamics/settings.html)
- [Warp Volume](https://nvidia.github.io/warp/latest/api_reference/_generated/warp.Volume.html), [Warp 변경 기록](https://nvidia.github.io/warp/stable/project/changelog.html)
- [DSX Blueprint 개요](https://docs.omniverse.nvidia.com/dsx/latest/overview.html)

## 2. 이 프로젝트에서 Omniverse가 맡는 일

| 역할 | 쓰는 것 | 설명 |
|---|---|---|
| 장면의 기준 | OpenUSD | 모든 에셋과 장면의 기준 형식 ([09](09_usd_spec.md)) |
| **열 시뮬레이션** | NVIDIA Warp | USD 장면의 형상(랙, 벽)을 읽어 공기 중 열의 이동을 GPU에서 계산한다. DSX가 열 시뮬레이션에 쓰는 기술 목록에도 Warp가 있다. |
| **가상 센서** | Warp + USD | 센서 앵커의 위치에서 시뮬레이션 결과(온도)를 읽어 센서 값으로 만든다. |
| 열·기류 시각화 데이터 | Warp(NanoVDB) 또는 Flow(Kit) | 같은 시뮬레이션 결과를 부피 데이터로 저장해 Unreal에서 그린다. |
| 같은 장면 그리기 | ovrtx | Unreal과 비교하는 기준(E2). 카메라 센서 영상을 만드는 확장도 가능 |
| (연구) Kit 앱 | Kit SDK, Flow, 스트리밍 | 설치와 호환을 확인한 뒤 쓸 부분을 정한다(R1, R2). |

센서 값이 "일반 Python의 간단한 모델"에서 "**USD 형상 위에서 계산한 열 시뮬레이션 결과를 가상 센서로 읽은 값**"으로 바뀐다. 이 점이 이전 설계와 다른 가장 큰 부분이다.

## 3. 열 시뮬레이션 설계 (초안)

### 3.1 단계
| 단계 | 방식 | 난이도 | 비고 |
|---|---|---|---|
| L0 | 간단한 모델(1차 지연). [11 데이터 규격](11_data_spec.md) 6.2 | 낮음 | **기준선이자 대체 수단.** Warp 작업이 막혀도 프로젝트가 진행된다. |
| L1 | **정해 둔 공기 흐름 위에서 열이 이동하고 퍼지는 계산**(이류-확산). 흐름은 CRAC 공급구와 랙 팬 위치로 정한 값 | 중간 | 이번 목표. 계산이 안정적이고 해석하기 쉽다. |
| L2 | 공기 흐름까지 계산(비압축성 유체 솔버) | 높음 | 여력이 있을 때만. Warp 유체 예제를 참고 |

### 3.2 계산 영역 (L1 기준)
| 항목 | 값 |
|---|---|
| 홀 크기 | 약 12 x 9 x 3.5 m (랙 2줄 x 10기, 통로 포함. 모델링 후 확정) |
| 격자 간격 | 20 cm → 약 60 x 45 x 18 = 약 48,600칸 |
| 열원 | 랙(전력에 비례, 뒷면에서 열 배출), 장비 |
| 냉각원 | CRAC 공급구(팬 속도에 비례해 찬 공기 공급) |
| 막힌 곳 | 랙, 벽(USD 형상에서 읽음) |
| 시간 | 1초를 여러 번 나누어 계산하고, 센서는 1초마다 읽음 |

이 규모는 GPU 한 대에서 실시간으로 도는 데 부담이 없을 것으로 예상하지만 **측정 전 가정**이다.

### 3.3 가상 센서
- 센서 앵커의 월드 좌표를 USD에서 읽어 해당 위치의 온도를 격자에서 보간해 읽는다.
- 전력, 팬 속도 같은 비열 센서는 시나리오가 직접 만든 값이다.
- 같은 시드와 같은 시나리오면 같은 값이 나오게 한다(재현성).

### 3.4 정직한 표기
교육·시각화용 간단한 모델이며, 실제 데이터센터의 열 설계나 용량 계산에 쓸 수 없다. DSX의 CFD 시뮬레이션과 같은 수준이 아니다. 문서와 화면에 그렇게 표시한다.

## 4. 연구 과제 (R1~R7)

각 과제는 GitHub Issue로 만들고 Milestone "연구 트랙: Omniverse"에 묶는다.

| 번호 | 질문 | 방법 | 성공 기준 | 막히면 |
|---|---|---|---|---|
| R1 | Kit SDK가 RTX 5090에서 동작하는가 | NGC에서 Kit SDK를 받아 Kit App Template으로 빈 앱 실행 | 앱이 열리고 USD 장면(`rack.usda`)이 보인다 | Kit 없이 라이브러리와 Warp로 진행(L0, L1) |
|  | **결과: 성공(2026-10-15).** Kit 110.4.0, 첫 실행 239초와 이후 12초, 설치 약 2.5GB. 우리 `poc_hall.usda`를 열어 화면에 그림 | | | |
| R2 | Flow로 만든 연기를 Unreal에서 쓸 수 있는가 | R1 이후 Flow 확장으로 연기를 만들고 NanoVDB/OpenVDB로 내보내 Unreal에서 가져오기 | Unreal에 부피 데이터가 보인다 | Warp 결과를 직접 VDB로 변환 (R5) |
|  | **중간 결과: 부분 성공.** Kit에서 OpenVDB 내보내기 성공. 용량 7.2GB와 속도 저하(4.8 vs 47.6 FPS)가 문제. Unreal 읽기는 미시험 | | | |
| R3 | DSX Blueprint에서 따라 할 만한 구조는 무엇인가 | 공식 문서의 구조(Kit 앱 + 스트리밍 + 웹)와 열·전기 시뮬레이션 구성을 읽고 정리 | 우리 설계와 비교한 표 1장 | 문서만 읽고 끝내도 된다(실행 불필요) |
| R4 | ovrtx를 `ovstage` 방식으로 옮길 수 있는가 | 동작 확인 테스트를 `ovstage` 방식으로 다시 작성 | 같은 장면이 같은 결과로 그려진다 | 0.3.0 방식을 고정 버전으로 계속 사용 |
| R5 | Warp로 열 시뮬레이션(L1)과 가상 센서를 만들 수 있는가 | 작은 방(박스)에서 열원과 냉각원 계산, 센서 위치 읽기, NanoVDB 저장 | 열이 퍼지는 모습이 결과에 보이고 센서 값이 시간에 따라 변한다 | L0 모델 사용 |
| R6 | Warp 결과(NanoVDB)를 Unreal이 쓸 수 있는 형식(OpenVDB 등)으로 바꿀 수 있는가 | 변환 도구 후보 시험(OpenVDB 변환기, Blender 경유, 3D 텍스처 이미지 묶음) | Unreal에서 볼륨으로 가져온다 | 3D 텍스처 이미지 묶음 방식 |

| R7 | Omniverse와 Unreal을 직접 연동하는 공식 도구가 지금도 있는가 | 공식 문서와 릴리스 노트에서 Unreal 연동(커넥터, 장면 실시간 동기) 현황 조사, 가능하면 짧게 시험 | 지원 상태, 버전, 제약을 표로 정리 | 이 프로젝트는 MQTT와 파일 방식으로 구성되어 있어 영향 없음. 비교 대상으로만 기록 |

### 우선순위와 순서
1. **R5(열 시뮬레이션)**: 프로젝트의 중심이고 Kit 설치와 무관하게 시작할 수 있다. 가장 먼저 한다.
2. **R1(Kit 설치)**: 설치가 오래 걸릴 수 있으니 병행한다. 결과가 R2와 R3을 정한다.
3. **R6, R2, R7**: 부피 데이터와 직접 연동 경로를 확인한다.
4. **R4, R3**: 정리 성격이라 여유가 있을 때 한다.

## 5. 환경 주의
- Python은 3.13을 쓴다(ovrtx 지원 범위 3.10~3.13, 시스템 기본 3.14는 사용하지 않는다).
- Warp와 usd-core는 별도 uv 환경에 설치한다(`sim/` 아래). 설치 전에 현재 버전과 RTX 5090 지원 여부를 확인하고 결과를 `05_env_status.md`에 적는다.
- Kit SDK는 용량이 클 수 있다. 설치 위치는 D 드라이브(여유 1.2TB)로 한다.
- 인터넷 연결이 필요한 단계가 있다(ovrtx 첫 실행의 자산 내려받기 등).

## 6. 포트폴리오에서 보여줄 것
- "무엇을 써 봤다"가 아니라 **"이 질문을 이렇게 확인했고, 이런 결과가 나왔다"** 를 보여 준다. 각 과제의 결과(성공, 부분 성공, 실패와 이유)를 `experiments/`에 기록하고 요약을 문서에 남긴다.
- 실패한 과제도 이유와 대안을 적으면 가치 있는 연구 결과다.


## 7. 화재, 열 전도, CFD와 다른 시뮬레이션 (실증 결과 요약)

Kit 110.4.0 확장 레지스트리 685개를 조회하고 직접 실행한 결과다. 자세한 표는 `experiments/results/E0_omniverse_capability_probe.md` 2.8-2장(PR #33)에 있다. **확장 이름에 없다는 것이 불가능하다는 뜻은 아니다.**

| 질문 | 답 |
|---|---|
| 화재 | **가능**(시각적 시뮬레이션). Flow `Fire` 프리셋을 직접 실행했다. 공학적 화재 해석은 아니다. |
| 열 전도(고체) | Kit 기본 확장에는 없다. Warp로 직접 구현해야 한다. 지금 구현한 것은 공기 속 열의 이동과 확산뿐이다. |
| CFD | Kit 기본 레지스트리에 CFD 확장이 없다. **우리 모델(L1)은 CFD가 아니다.** DSX 문서의 CFD는 Kit-CAE 등을 언급하지만 설치해 보지 않았다. |
| 물리, 합성 데이터, 센서 | 확장이 있으나 시험하지 않았다(PhysX, Replicator, 라이다·레이더·음향). |
| 전기 부하와 PUE | Omniverse 확장이 없다. Python으로 계산한다(집계 값). |
