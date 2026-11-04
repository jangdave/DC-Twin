# 28. Kit 실행 결과와 상용 데이터센터 도구(Reality DC) 활용 방안

- 상태: 초안 (2026-11-04)
- 목적: (1) Omniverse Kit으로 시뮬레이션 값을 뽑아 본 결과와 다음 선택지, (2) 상용 도구인 Cadence Reality DC를 이 프로젝트에서 어디까지 쓸 수 있는지 정리한다.
- 관련: [E0 결과 2.24장](../experiments/results/E0_omniverse_capability_probe.md), [04 회사 자산 분리 규칙](04_clean_room_policy.md), [ADR-006](decisions/ADR-006-omniverse-based-simulation.md), [ADR-009](decisions/ADR-009-hall-layout-and-cooling.md)

## 1. Kit으로 시뮬레이션 값 뽑기: 확인한 것
Kit 안에서 우리 열 시뮬레이션(L1)과 센서 값 생성기를 돌려, 독립 실행과 같은 값이 나오는 것을 확인했다(센서 CSV 차이 0.0, 녹화 62,705줄에서 숫자 최대 차이 0.001 = 반올림 한 칸). 자세한 표는 E0 결과 2.24장.

**솔직한 해석:** Kit이 한 일은 USD 열기와 Warp 실행 환경 제공이다. 열 모델은 Kit 기능이 아니라 우리 솔버이고, Kit에는 CFD나 열 확장이 없다. 지금은 Kit으로 돌려도 결과가 같고 더 느리다. 즉 "Kit으로 데이터를 만들 수 있다"는 것을 증명했지만 "Kit이 더 낫다"는 것은 아니다.

### 1.1 다음 선택지
| 선택지 | 하는 일 | 얻는 것 | 한계 |
|---|---|---|---|
| A. Kit에서 L2 녹화 만들기 | `kit_sensors.py`를 `--solver l2`로(scikit-learn도 Kit용으로 받아야 함) | 데이터 생성 전체를 Kit 한 곳에서 | 결과가 같아 새 값이 없다 |
| B. Flow 온도 채널을 센서 앵커에서 읽기 | Kit의 Flow로 랙 열 플룸을 만들고, 앵커 위치의 온도를 읽어 센서 값으로 | **Kit 고유 기능이 만든 값**을 얻는다(L1과 다른 계열) | Flow는 시각 효과용이라 우리 열 모델과 달리 보정되지 않았다. 프레임이 10배 떨어지고 용량이 크다(E0 2.7장). 값의 의미를 따로 정의해야 한다 |
| C. Replicator로 가상 CCTV 영상 | Kit의 Replicator로 구역별 영상과 라벨 | 웹 CCTV와 연결되는 합성 데이터 | 미시험. 센서 값은 아님 |
| D. 웹 화면 연결 | 실제 게이트웨이를 띄워 Kit이 만든 녹화를 `?live=`로 | 센서 연결 경로 확인 | 데이터 내용은 같음 |

권장: **B를 작게 시험**(랙 한 줄, 10분 안에 끝낼 수 있는 범위)하고, 값이 쓸 만한지 보고 계속할지 정한다. A와 D는 B 뒤에 한다.

## 2. 상용 도구(Cadence Reality DC) 활용 방안
(이 문서에서 "리얼 DC"는 업무에서 쓰는 Cadence Reality DC로 본다. 틀렸다면 알려 달라.)

### 2.1 공개 자료로 확인한 사실 (2026-11-04 확인, 제조사 주장은 검증하지 않음)
- Cadence는 CFD 기반 데이터센터 도구(Reality DC Design)와 디지털 트윈 플랫폼을 제공하고, **OpenUSD로 NVIDIA Omniverse와 연결**한다. 용량 계획(설치, 계획, 철거 영향 추적, 낭비 용량 파악), 시나리오 시험("장애 대비 훈련"), 실시간 연동(BMS, DCIM 등)을 내세운다. 효율 30% 개선, 30배 빠름은 **제조사 수치**다. 출처: [Cadence 기술 문서](https://www.cadence.com/en_US/home/resources/technical-briefs/cadence-reality-digital-twin-platform-and-nvidia-omniverse-integration-tb.html), [보도자료](https://www.businesswire.com/news/home/20240318127116/en/Cadence-and-NVIDIA-Unveil-Groundbreaking-Generative-AI-and-Accelerated-Compute-Driven-Innovations).
- NVIDIA는 Kit용 공식 확장 [`omni.kit.cadence_reality_dc_design`](https://docs.omniverse.nvidia.com/kit/docs/omni.kit.cadence_reality_dc_design/latest/Overview.html)을 제공한다(문서 갱신일 2025-01-08). `.room` 모델과 속성, `.vtk` CFD 결과를 Omniverse로 가져오고, 단면 슬라이스를 만들거나, `.vtk`를 NanoVDB로 바꿔 Flow 확장에서 보여 준다. **로컬에 Cadence Reality DC Design 설치가 필요**하고, 확장은 기본으로 꺼져 있다. 지원하는 Cadence와 Kit 버전은 문서에 적혀 있지 않다.

### 2.2 이 프로젝트의 규칙과의 관계
[CLAUDE.md](../CLAUDE.md)와 [04](04_clean_room_policy.md): 재직 회사 프로젝트의 코드, 에셋, 데이터를 쓰지 않고, **상용 도구(외부 CFD 제품 등)로 계산한 결과나 화면은 올리지 않는다.** 공개 전에 회사 확인을 받는다(04 원칙 3). 아래 방안은 이 선을 넘지 않는 것만 모았다.

### 2.3 방안
| 방안 | 내용 | 규칙상 | 권장 |
|---|---|---|---|
| A. 개념만 참고 | 공개된 기능 범주를 우리 화면과 맞춘다. 용량 계획 ↔ 에너지·용량 탭, 장애 훈련 ↔ 이상 대비 탭. 아직 없는 것: **낭비 용량**(랙 여유 전력의 합은 있으나 냉각이 받쳐 주지 못해 못 쓰는 부분) 지표 | 가능(공개 자료, 개념 수준). 지표 정의는 우리가 직접 한다 | 권장. 작게 할 수 있다 |
| B. 같은 구조를 공개 도구로 | 위 확장이 쓰는 **외부 CFD 결과(VTK) → NanoVDB → Kit** 경로를 OpenFOAM으로 만든다. OpenFOAM 결과는 이미 있고(E5) VTK로 내보낼 수 있다. ADR-009의 "외부 솔버 결과는 같은 격자로 받는다"와 같은 방향 | 가능(공개 도구, 우리 가상 홀) | 권장. 다만 Kit에서 VTK 변환 확장(`omni.kit.converter.vtk`)을 받을 수 있는지는 **아직 확인하지 못했다** |
| C-1. 결과를 받는 파이프라인(구성만 함, 2026-11-04) | 상용 도구의 VTK 결과를 서버를 거쳐 **이 컴퓨터의 화면에서만** 보이게 하는 변환 파이프라인을 만들었다. 결과는 저장소 밖(gitignore)에만 두고 공개 사이트에는 안 나간다. 실제 외부 파일로는 시험하지 못했다([server/README](../server/README.md), docs/27 16.8) | 구성은 규칙을 지킨다. **결과를 실제로 만들어 넣는 일은 아래 C의 확인이 있어야 한다** | 구성 완료 |
| C. 로컬에서만 비교 | 우리 가상 홀 형상을 상용 도구에서도 계산해 **경향이 같은지만** 본다(결과와 화면은 저장소와 문서에 올리지 않음, `local_only/`) | **사용자와 회사가 확인해야 한다.** 라이선스가 개인 포트폴리오 용도를 허용하는지, 회사 규정에 걸리는지는 내가 판단할 수 없다. 나는 회사 자산에 접근하지 않는다 | 보류. 허락이 있을 때만 |
| D. 쓰지 않는 것 | 회사 `.room` 파일이나 설치본의 예제를 가져오기, 상용 결과(`.vtk`, CSV)나 화면 캡처를 저장소, PR, 영상, 문서에 넣기, 확장을 회사 설치본에 연결해 시연 화면을 만들기 | 금지 | - |

### 2.4 정리
- 지금 바로 할 수 있고 규칙에 안전한 것은 **A와 B**다. 둘 다 공개 자료와 공개 도구만 쓴다.
- C는 가치가 있지만(상용 도구와의 경향 비교는 신뢰도를 높인다) **허락을 받아야 시작할 수 있다.** 허락을 받으면 결과는 저장소 밖에 두고, 문서에는 "경향이 같다/다르다" 정도의 서술만 남길지부터 정한다. 그 서술이 04의 "결과 사용 금지"에 걸리는지는 회사 확인 사항이다.
