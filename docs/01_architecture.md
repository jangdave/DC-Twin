# 01. 전체 구조

- 상태: 채택 v0.2 (2026-10-15, 설계 재점검 반영). 세부 설계는 이 문서에서 링크한 문서에 있다.
- 목적: 프로젝트의 큰 그림을 한 곳에서 보여 주고, 세부 문서로 안내한다.
- 읽는 사람: 이 프로젝트를 처음 보는 사람

## 1. 한 줄 설명
Blender로 직접 모델링한 **가상 데이터센터**를 OpenUSD로 정의하고, 센서 값과 열·기류 데이터를 만들어 내고, Unreal Engine 5.8로 운영 화면(운영자가 보는 프로그램)을 만든다. 운영 화면은 Pixel Streaming으로 브라우저에서도 볼 수 있게 한다.

## 2. 세부 문서 목록

| 문서 | 내용 |
|---|---|
| [02 로드맵](02_roadmap.md) | 단계(Phase)별 계획과 산출물 |
| [03 비교 실험](03_experiments.md) | 선택의 근거를 숫자로 남기는 실험 |
| [08 설계 재점검](08_design_review.md) | 문제와 결정, 아직 정하지 않은 것 |
| [09 USD 규격](09_usd_spec.md) | 3D 에셋과 장면의 구조, 이름, 센서 앵커 |
| [10 모델링 가이드](10_modeling_guide.md) | 서버 랙을 만드는 방법과 점검표 |
| [11 데이터 규격](11_data_spec.md) | 센서, MQTT, 게이트웨이, 시나리오 |
| [12 Unreal 설계](12_unreal_design.md) | 클라이언트 구성, 화면, 내부 둘러보기, Unreal 고유 기능, 시험 |
| [13 Omniverse 연구 계획](13_omniverse_research.md) | 확인한 사실, 열 시뮬레이션 설계, 연구 과제 R1~R7 |
| **[14 핵심 설계](14_sim_to_unreal_core.md)** | **시뮬레이션과 센서 데이터의 Unreal 연동·표현** (이 프로젝트의 핵심) |
| [18 웹 보기 화면 기능명세](18_web_viewer_spec.md) | Unreal과 별도로 만든 웹(WebGL) 보기 화면의 기능, 데이터, 시험 |
| [설계 결정 기록](decisions/) | 왜 이렇게 정했는지 |

## 3. 왜 Omniverse와 Unreal을 나눠 쓰는가

| | 장면 정의와 데이터 만들기 | 운영 화면 |
|---|---|---|
| 필요한 것 | 장면 조립, 데이터 생성 | 낮은 지연, 알람, 여러 사용자에게 배포 |
| 쓰는 도구 | Blender, OpenUSD, Python, Omniverse 라이브러리(ovrtx) | Unreal 5.8 (C++, CommonUI, Pixel Streaming) |

- "Unreal이 더 낫다"는 주장이 아니라 **운영 화면이라는 용도에서의 선택**이다. 같은 장면을 Omniverse 쪽 뷰어(ovrtx)로도 그려 비교한다([03 비교 실험](03_experiments.md)).

### Omniverse를 쓰는 범위 ([ADR-006](decisions/ADR-006-omniverse-based-simulation.md))
시뮬레이션과 데이터 생성은 **Omniverse 계열 기술**로 만든다. 라이브러리(ovrtx, ovphysx)와 Kit 앱(Kit SDK 110.4.0, `D:\omniverse-kit\kit-app-template`의 `dctwin.base_editor`)을 모두 설치했고, RTX 5090에서 실행을 확인했다(2026-10-15, [05 환경 상태](05_env_status.md)). 아직 Kit 앱으로 만든 데이터는 없고, 지금 열 시뮬레이션은 Python(Warp 계열 시험 코드)으로 돌린다.

| Omniverse 쪽에서 맡는 것 | 쓰는 기술 | 상태 |
|---|---|---|
| 장면의 기준 | OpenUSD | 사용 중 |
| 열 시뮬레이션과 가상 센서 | NVIDIA Warp (USD 형상을 읽어 계산) | 연구 R5 |
| 열·기류 부피 데이터 | Warp(NanoVDB) 또는 Flow | 연구 R2, R6 |
| 같은 장면 그리기(비교 기준) | ovrtx | 동작 확인 완료 |
| Kit 앱 | Kit SDK, Flow, 스트리밍 | 설치와 RTX 5090 실행 확인 완료. Flow, 스트리밍 활용은 연구 R1 |

연구 계획과 확인한 사실은 [13 Omniverse 연구 계획](13_omniverse_research.md)에 있다.

### Unreal에서만 만들기 쉬운 기능
운영 화면에는 걸어 다니기, 안내 투어, 상호작용, 실시간 시각·음향 효과처럼 Unreal이 기본으로 제공하는 기능을 더한다. Omniverse에서 만들 수 없다는 뜻이 아니라 **구현 비용이 낮은 기능**이며, 같은 기능을 양쪽에서 만드는 비용을 비교 실험(E2)에서 잰다. 목록은 [12 Unreal 설계](12_unreal_design.md) 11장에 있다.

## 4. 데이터가 흐르는 길 세 가지

| # | 길 | 내용 | 방식 |
|---|---|---|---|
| 1 | 정적 장면 | 건물, 랙, 설비 구조와 센서 위치 | Blender → USD → Unreal 가져오기 |
| 2 | 미리 계산한 데이터 | 열·기류 볼륨 | Python 또는 Blender → VDB 파일 → Unreal 재생 |
| 3 | 실시간 데이터 | 온도, 전력, 팬 속도, 알람 | 센서 값 생성기 → MQTT → 게이트웨이 → WebSocket → Unreal |

## 5. 구성도

```
[Blender 5.1] 랙·설비 모델링
      │ 내보내기 + 마무리 스크립트
      ▼
[USD 에셋] ──(장면 생성 스크립트: 참조로 배치, 센서 ID 붙임)──▶ [USD 장면 /DC/Hall01/...]
                                                                   │
                         ┌─────────────────────────────────────────┤
                         ▼                                         ▼
              [센서 매니페스트 JSON]                    [Unreal 5.8 DataCenter_DT]
              (센서 목록·위치·기준값)                     · USD 가져오기, 센서 위치 연결
                 │         │                              · 온도 색, 알람 강조, 열·기류 볼륨
                 │         │                              · CommonUI 패널 + 일부 웹 패널
   [열 시뮬레이션(Warp) + 가상 센서] ─MQTT─▶ [Mosquitto] ─▶ [게이트웨이] ─WebSocket/REST─▶ Unreal
     (센서 앵커 위치에서 온도를 읽음)                    (최근 값, 알람 판정, 이력)         │
                                                                                          └─▶ Pixel Streaming ─▶ 브라우저
   [같은 시뮬레이션 결과] ─VDB 파일─▶ Unreal 볼륨

   [Omniverse ovrtx] ─같은 USD 장면을 그림─▶ 비교 실험(E2)
```

## 6. 부품 요약

| 부품 | 위치 | 역할 | 상세 |
|---|---|---|---|
| USD 에셋과 장면 | `usd/` | 3D 구조와 센서 앵커 | [09](09_usd_spec.md) |
| 모델링 | `blender/` | 랙 원본과 내보내기 스크립트 | [10](10_modeling_guide.md) |
| 센서 값 생성기 | `sim/sensors/` | 시나리오별 센서 값을 MQTT로 발행 | [11](11_data_spec.md) |
| 열·기류 데이터 | `sim/thermal/` | 볼륨 데이터(VDB) 생성. 도구는 Phase 4에서 결정(D2) | [08](08_design_review.md) P5 |
| 게이트웨이 | `gateway/` | MQTT 수신, 알람 판정, WebSocket 전달, 녹화·재생 | [11](11_data_spec.md) |
| Unreal 클라이언트 | `unreal/` | 3D 뷰, 알람, 그래프, 스트리밍 | [12](12_unreal_design.md) |
| 시뮬레이션 서버 | `server/`, `sim/sensors/dct_sensors/serve.py`, `api.py` | 상세 시뮬레이션 계산(L0, L1, L2)과 미리 계산한 값 제공. 웹 화면이 연결해 쓴다 | [server/README](../server/README.md) |

## 7. 서비스 방식
- **주력:** Pixel Streaming(웹). **기준선:** Windows 패키징(exe). **비교 대상:** Omniverse(ovrtx) 뷰어.
- **UI:** CommonUI 기본에 일부 패널(추이 그래프 등)을 웹으로 만드는 혼합안. 1~2개 패널로 비교 후 확정한다(E4).
- **호스팅:** GPU 서버가 없으므로 영상과 exe를 상시 산출물로 두고, 라이브 스트리밍은 시연용이다([ADR-004](decisions/ADR-004-streaming-hosting.md)).
- **웹 보기 화면:** Unreal과 별도로 Three.js 기반 보기 전용 화면(`web/viewer/`)을 정적 배포할 수 있게 만들었다. 같은 게이트웨이 WebSocket이나 녹화 파일을 받아 온도 색과 신뢰 막대를 보인다. Unreal을 대체하지 않는다([ADR-011](decisions/ADR-011-webgl-viewer.md), [기능명세 18](18_web_viewer_spec.md)).
- **제외:** 모바일 앱, XR.

## 8. 보여줄 데모 시나리오
**화면 흐름:** 첫 화면은 현실적인 데이터센터 **외관**(4K). 건물을 누르면 **서버 랙 공간(한 층)** 이 열리고, 전력량과 열 이동 시뮬레이션을 확인하며, 그 공간을 **걸어 다니며 둘러볼 수 있다.** ([12 Unreal 설계](12_unreal_design.md) 12장, [ADR-008](decisions/ADR-008-screen-flow-exterior-to-floor.md))

1. 정상 가동: 랙 온도가 색으로 보이고 전력이 완만하게 변한다.
2. 냉각 장치(CRAC) 고장: 온도가 오르고, 주의 → 위험 알람이 뜨고, 해당 랙이 강조되고, 기류 볼륨이 변한다.
3. 알람 목록에서 항목을 누르면 해당 장비로 카메라가 이동하고, 추이 그래프를 본다.
4. **내부 둘러보기:** 1인칭으로 통로를 걸으며 가까운 랙의 센서 값을 보고, 안내 투어로 주요 지점을 돌아본다. 팬 소리와 기류 효과가 상태에 따라 변한다.
5. (선택) AI 에이전트가 알람을 요약하고 조치를 제안한다.

## 9. 범위 밖
실제 열역학 해석의 정확도 주장, 장비 제어(읽기 전용), 로그인과 권한, 모바일과 XR, 상용 수준의 확장성. 필요하면 "향후 과제"로 문서에 적는다.

## 10. 정해지지 않은 것
[08 설계 재점검](08_design_review.md) 5장의 결정 D1~D4를 본다.
