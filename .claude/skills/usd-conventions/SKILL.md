---
name: usd-conventions
description: 이 프로젝트의 USD 에셋/씬 작성 규칙(prim 경로, 단위, 축, dct: 메타데이터)을 적용하거나 검증할 때 사용. "USD 규칙", "prim 네이밍", "센서 메타데이터", "USD 내보내기" 요청에 사용.
---

# USD 규칙 (DC-Twin)

## 기본
- 단위 cm (`metersPerUnit = 0.01`), Up-axis Z, 기본 prim `/DC`.
- 에셋은 모듈별 파일(`usd/assets/*.usd`), 씬은 reference로 조립(`usd/scenes/*.usd`).

## prim 경로 (v2)
```
/DC
  /Hall01
    /Row01/Rack_01 ... Rack_NN        (랙, 번호는 홀 안에서 이어서 매김)
      /Server_U01 ...                 (서버, 선택)
      /Anchors/Sensor_TEMP_IN ...     (센서 앵커)
    /Cooling/CRAC_01 ...              (공조, 센서 앵커 포함)
    /Power/PDU_01 ...                 (배전, 센서 앵커 포함)
    /Shell/...                        (바닥, 벽, 천장, 걸레받이, 표시, Lights)
    /Looks/M_...                      (재질, UsdPreviewSurface)
    /Containment/...                  (열기 통로 격벽)
    /Vents/Vent_01 ...                (바닥 급기구)
    /Tour/View_01 ...                 (투어 지점, 예정)
  /Building01                         (건물 외관, assetType = building)
    /Exterior  /Floors  /Outdoor      (Outdoor는 assetType = outdoor, 09 규격 12장)
```
- `/DC` 바로 아래는 `Hall##`, `Building##` 둘 다 허용. `Building##` 아래는 `Exterior`, `Floors`, `Outdoor`만 허용.
- 번호는 두 자리 이상 0 패딩, 영문 PascalCase + 언더스코어 번호.

## 커스텀 속성 (접두 `dct:`)
| 속성 | 타입 | 붙는 곳 | 예 |
|---|---|---|---|
| `dct:assetType` | token | 장비, 센서 앵커, 외피 등 | rack, server, crac, pdu, sensor, shell, containment, vent, building, outdoor |
| `dct:sensorId` | string | 센서 앵커(장면에서만) | `H01-RK01-TEMP-IN` |
| `dct:metric` | token | 센서 앵커 | `temp_in` |
| `dct:unit` | string | 센서 앵커 | `degC` |
| `dct:zone` | token | 랙, 센서 앵커(선택) | cold_aisle, hot_aisle |
| `dct:title` | string | 건물 | `Data Center Building` |
| `dct:floor` | int | 홀, 층 표시 모양(선택) | 3 |

- 센서 ID는 경로에서 계산한다: `H` + 홀 번호 + `-` + 장비 코드(RK, CR, PD) + 장비 번호 + `-` + 측정 종류(대문자, `_`는 `-`). MQTT 주소는 `dct/v1/hall01/rack_01/temp_in` 형식.
- 앵커 이름은 `Sensor_<METRIC 대문자>`이고 `dct:metric`과 같아야 한다.

## 파일 종류 두 가지
| 종류 | 설명 | 검사 옵션 |
|---|---|---|
| 장면(scene) | `/DC` 아래에 홀을 조립한 파일. `build_scene.py`가 설정 파일에서 만든다. 기본값 | `--kind scene` |
| 에셋(asset) | 랙 1기, CRAC 1기처럼 한 부품. 기본 prim에 `dct:assetType`이 있어야 한다. 센서 앵커에 `metric`, `unit`은 있고 센서 ID는 장면에서 붙인다. | `--kind asset` |

## 검사하는 규칙 (오류 번호)
| 번호 | 내용 |
|---|---|
| U000 | 파일을 열 수 없음 |
| U101 / U102 / U103 | 단위(cm), 위쪽 축(Z), 기본 prim(장면은 `DC`) |
| U201 | 에셋의 기본 prim에 `dct:assetType`이 없음 |
| U202 / U203 | 장비 이름인데 `dct:assetType`이 없음 / 값이 올바르지 않음 |
| U301 / U302 | 장면의 계층 이름(`/DC` 아래 Hall## 또는 Building##, Hall 아래 Row##, Cooling, Power, Containment, Shell, Vents, Looks, Tour, Building 아래 Exterior, Floors, Outdoor) / 종류별 경로 규칙 |
| U401 | 랙·CRAC·PDU에 센서 앵커가 하나도 없음 |
| U402 / U403 | 센서 ID 누락·형식 오류·경로에서 만든 값과 다름 / 중복 |
| U404 | 센서 앵커에 `dct:metric`, `dct:unit`이 없거나 앵커 이름이 metric과 다름 |
| U501 | `dct:zone` 값 오류 |
| U502 | `dct:floor`가 1 이상의 정수가 아님 |

## 검증 방법
```
cd scripts/usd_tools
uv run --python 3.13 python validate_usd.py <파일.usda>
uv run --python 3.13 python validate_usd.py --kind asset <에셋.usda>
uv run --python 3.13 python -m pytest        # 검증기 자체 테스트
```
- 오류가 있으면 종료 코드 1, 없으면 0. 예시 파일은 `scripts/usd_tools/examples/`에 있다.
- 장면 만들기: `uv run --python 3.13 python build_scene.py ../../usd/scenes/hall01.config.json ../../usd/scenes/hall01.usda` 후 검증한다.
- 규칙을 바꾸면 `validate_usd.py`, 테스트, 이 문서를 함께 고친다.
- 변환 손실(E1) 기록(`docs/03_experiments.md`)에 갱신할 항목이 있는지도 확인한다.
