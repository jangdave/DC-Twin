# 문서 목차

- 상태: 채택
- 목적: `docs/`의 문서가 무엇이고 지금 얼마나 믿을 수 있는지 한눈에 보게 한다. 새 문서를 만들면 여기에 한 줄 추가한다.
- 읽는 순서 제안: 처음 보면 01 설계 개요, 02 로드맵, 14 핵심 설계, 27 웹 화면 계획. 용어는 07, 회사 자산 분리 규칙은 04.

## 문서

| 파일 | 제목 | 상태 |
|---|---|---|
| [01_architecture.md](01_architecture.md) | 전체 구조 | 채택 |
| [02_roadmap.md](02_roadmap.md) | 로드맵 (약 17주, 단계별 산출물) | 채택 |
| [03_experiments.md](03_experiments.md) | 비교 실험 설계 | 채택 |
| [04_clean_room_policy.md](04_clean_room_policy.md) | 회사 자산 분리 규칙 / 공개 정책 (파일 이름의 `clean_room`은 그대로 둔다) | 채택 |
| [05_env_status.md](05_env_status.md) | 환경 상태 (2026-10-15 점검) | 점검일 기준(오래됨) |
| [06_workflow.md](06_workflow.md) | 개발 워크플로 (브랜치·커밋·PR·릴리스) | 채택 |
| [07_glossary_and_writing_rules.md](07_glossary_and_writing_rules.md) | 용어집과 문서 작성 규칙 | 채택 |
| [08_design_review.md](08_design_review.md) | 설계 재점검 (모델링 시작 전) | 채택 |
| [09_usd_spec.md](09_usd_spec.md) | USD 규격 (v2) | 채택 |
| [10_modeling_guide.md](10_modeling_guide.md) | 모델링 가이드 (서버 랙) | 채택 |
| [11_data_spec.md](11_data_spec.md) | 데이터 규격 (센서, MQTT, 게이트웨이) | 초안 v1 |
| [12_unreal_design.md](12_unreal_design.md) | Unreal 클라이언트 설계 | 초안 v1 |
| [13_omniverse_research.md](13_omniverse_research.md) | Omniverse 연구 계획 | 초안 v1 |
| [14_sim_to_unreal_core.md](14_sim_to_unreal_core.md) | 시뮬레이션과 센서 데이터의 Unreal 연동·표현 (핵심 설계) | 초안 v1 |
| [15_exterior_references.md](15_exterior_references.md) | 건물 외관 레퍼런스 조사 | 초안 |
| [16_interior_references.md](16_interior_references.md) | 서버 홀 내부 레퍼런스 조사 | 초안 |
| [17_direction_review.md](17_direction_review.md) | 방향 검토: 포트폴리오 취지, 시뮬레이션 방식(Modelica, CFD, AI 대리 모델) | 초안 |
| [18_web_viewer_spec.md](18_web_viewer_spec.md) | 웹 보기 화면 기능명세 | 초안 v1 |
| [19_project_review.md](19_project_review.md) | 프로젝트 전수 검토 (2026-11-02) | 검토 결과 기록 |
| [20_platform_flow_spec.md](20_platform_flow_spec.md) | 외관 → 홀 → 시뮬레이션 흐름 명세 (웹·Unreal 공통) | 초안 |
| [21_web_simulation_spec.md](21_web_simulation_spec.md) | 웹 직접 시뮬레이션 명세 | 채택 |
| [22_web_exterior_airflow_spec.md](22_web_exterior_airflow_spec.md) | 웹 외관 환경과 공기 흐름 | 채택 |
| [23_web_city_and_quality.md](23_web_city_and_quality.md) | 웹 도심 배경과 화질 단계 | 채택 |
| [24_web_design_system.md](24_web_design_system.md) | 웹 화면의 디자인 시스템 적용 | 채택 |
| [25_web_ux_layout.md](25_web_ux_layout.md) | 웹 화면의 UX 구조 정리 | 채택 |
| [26_web_city_natural.md](26_web_city_natural.md) | 자연스러운 도심과 외관 이미지 효과 | 채택 |
| [27_web_ui_redesign_plan.md](27_web_ui_redesign_plan.md) | 웹 화면 개편 계획 (목적 중심 메뉴, 모바일과 PC, 3D 조작, 로딩 화면) | 초안 |
| [28_kit_run_and_commercial_tool_options.md](28_kit_run_and_commercial_tool_options.md) | Kit 실행 결과와 상용 데이터센터 도구(Reality DC) 활용 방안 | 초안 |
| [29_server_side_rendering_review.md](29_server_side_rendering_review.md) | 3D 그리기를 서버로 옮기는 안 검토 | 초안 |
| [30_architecture_review.md](30_architecture_review.md) | 아키텍처 검토: 문제 진단 (2026-11-04) | 초안 |

`상태`가 "초안"인 문서는 결정 전의 제안이다. 숫자는 문서 맨 위의 날짜 기준이다. 실제 값은 코드와 시험이 정본이다.

## 결정 기록 (`decisions/`)

- [ADR-001-roles-omniverse-vs-unreal.md](decisions/ADR-001-roles-omniverse-vs-unreal.md)
- [ADR-002-domain-and-scope.md](decisions/ADR-002-domain-and-scope.md)
- [ADR-003-delivery-and-ui.md](decisions/ADR-003-delivery-and-ui.md)
- [ADR-004-streaming-hosting.md](decisions/ADR-004-streaming-hosting.md)
- [ADR-005-sensor-anchors-and-manifest.md](decisions/ADR-005-sensor-anchors-and-manifest.md)
- [ADR-006-omniverse-based-simulation.md](decisions/ADR-006-omniverse-based-simulation.md)
- [ADR-007-unreal-specific-features.md](decisions/ADR-007-unreal-specific-features.md)
- [ADR-008-screen-flow-exterior-to-floor.md](decisions/ADR-008-screen-flow-exterior-to-floor.md)
- [ADR-009-hall-layout-and-cooling.md](decisions/ADR-009-hall-layout-and-cooling.md)
- [ADR-010-unreal-engine-5-8.md](decisions/ADR-010-unreal-engine-5-8.md)
- [ADR-011-webgl-viewer.md](decisions/ADR-011-webgl-viewer.md)

## 그 밖의 문서

- [ASSET_LICENSES.md](ASSET_LICENSES.md): 외부 에셋과 라이선스
- 웹 보기 화면 설명: [../web/viewer/README.md](../web/viewer/README.md)
- 서버 실행과 인증: [../server/README.md](../server/README.md)
