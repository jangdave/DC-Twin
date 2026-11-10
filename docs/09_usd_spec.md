# 09. USD 규격 (v2)

- 상태: 채택 (2026-10-15). 검증 스크립트와 규칙 문서는 [이슈 #10](https://github.com/jangdave/DC-Twin/issues/10)에서 이 규격에 맞춘다.
- 목적: 3D 에셋과 장면을 어떤 구조와 이름으로 만들지 정한다. 모델링하는 사람, 스크립트를 쓰는 사람, Unreal 클라이언트를 만드는 사람이 같은 약속을 쓰게 한다.
- 관련 문서: [08 설계 재점검](08_design_review.md), [10 모델링 가이드](10_modeling_guide.md), [11 데이터 규격](11_data_spec.md)
- 용어는 [용어집](07_glossary_and_writing_rules.md)을 따른다.

## 1. 파일 종류

| 종류 | 설명 | 위치 | 만드는 방법 |
|---|---|---|---|
| 에셋(asset) | 랙 1기, CRAC 1기처럼 부품 하나를 담은 파일 | `usd/assets/` | Blender → 내보내기 → 마무리 스크립트 |
| 장면(scene) | 에셋을 홀에 배치한 파일 | `usd/scenes/` | 장면 생성 스크립트(`build_scene.py`) |

- 장면은 손으로 고치지 않는다. 배치를 바꾸려면 설정 파일을 고치고 스크립트를 다시 실행한다.
- 파일 형식은 텍스트(`.usda`)를 기본으로 한다. 바뀐 내용을 Git에서 읽을 수 있기 때문이다. 용량이 커지면 `.usdc`(Git LFS)로 바꾼다.

## 2. 기본 설정 (모든 파일 공통)

| 항목 | 값 | 이유 |
|---|---|---|
| 단위 | cm (`metersPerUnit = 0.01`) | Unreal의 기본 단위가 cm라서 크기 변환이 필요 없다. |
| 위쪽 축 | Z (`upAxis = "Z"`) | Unreal과 같다. |
| 기본 prim | 에셋은 에셋 이름(예: `Rack`), 장면은 `DC` | 다른 파일에서 참조하기 쉽다. |
| 좌표 | 에셋은 **바닥 중앙이 원점**, 앞쪽이 -Y | 배치할 때 위치 계산이 쉽다. |

## 3. 장면의 계층 구조

```
/DC                                  (기본 prim)
 └─ Hall01
     ├─ Row01
     │   ├─ Rack_01 ... Rack_10      (랙, 홀 안에서 번호를 이어서 매긴다)
     │   └─ ...
     ├─ Row02
     │   └─ Rack_11 ... Rack_20
     ├─ Cooling
     │   └─ CRAC_01 ... CRAC_04
     └─ Power
         └─ PDU_01 ... PDU_04
```

| 규칙 | 내용 |
|---|---|
| 이름 형식 | 영문 대소문자와 `_`, 번호는 **두 자리 이상**(`Rack_01`) |
| 번호 범위 | 장비 번호는 **홀 안에서 겹치지 않는다.** `Row02`의 첫 랙은 `Rack_01`이 아니라 `Rack_11`이다. |
| 장비 종류 | rack, server, crac, pdu |
| 경로 | rack: `/DC/Hall##/Row##/Rack_##`, server: 랙 아래 `Server_U##`, crac: `/DC/Hall##/Cooling/CRAC_##`, pdu: `/DC/Hall##/Power/PDU_##` |

## 4. 센서 앵커

센서 하나는 **prim 하나(센서 앵커)** 로 나타낸다. 장비 아래 `Anchors` 그룹에 둔다.

```
/DC/Hall01/Row01/Rack_01
 └─ Anchors
     ├─ Sensor_TEMP_IN      (입구 온도)
     ├─ Sensor_TEMP_OUT     (출구 온도)
     └─ Sensor_POWER        (전력)
```

| 속성 | 타입 | 예 | 설명 |
|---|---|---|---|
| `dct:assetType` | token | `sensor` | 센서 앵커 표시 |
| `dct:sensorId` | string | `H01-RK01-TEMP-IN` | 센서를 구분하는 값. 경로에서 만든다(5장). 장면에서만 붙인다. |
| `dct:metric` | token | `temp_in` | 측정 종류. 소문자와 `_` |
| `dct:unit` | string | `degC` | 단위 |

- 앵커의 **위치**가 센서의 3D 위치다. 화면에서 센서 표시나 알람 표시를 붙이는 기준점이 된다.
- 에셋 파일의 앵커에는 `dct:sensorId`가 없다. 같은 랙 에셋을 20번 쓰기 때문에, ID는 장면을 만들 때 인스턴스마다 붙인다(6장).
- 장비(rack, crac, pdu)는 센서 앵커를 **하나 이상** 가진다. 서버(server)는 센서가 없어도 된다.

### 장비별 센서 목록 (기본)

| 장비 | 센서 | 측정 종류(`dct:metric`) | 단위 |
|---|---|---|---|
| rack | 입구 온도, 출구 온도, 전력 | `temp_in`, `temp_out`, `power` | `degC`, `degC`, `kW` |
| crac | 공급 온도, 회수 온도, 팬 속도 | `supply_temp`, `return_temp`, `fan_speed` | `degC`, `degC`, `percent` |
| pdu | 전력, 부하율 | `power`, `load` | `kW`, `percent` |

처음 설계는 랙 20기 x 3 + CRAC 4기 x 3 + PDU 4기 x 2 = 센서 80개였다. 지금은 랙 60기 x 3 + CRAC 8기 x 3 = **센서 204개**이고 PDU는 장면에 없다([ADR-009](decisions/ADR-009-hall-layout-and-cooling.md)).

## 5. 이름과 ID 규칙

한 번 정하면 USD 경로, 센서 ID, MQTT 주소를 서로 계산해서 만들 수 있다.

| 항목 | 규칙 | 예 |
|---|---|---|
| USD 경로 | 3장, 4장 | `/DC/Hall01/Row01/Rack_01/Anchors/Sensor_TEMP_IN` |
| 센서 ID | `H` + 홀 번호 + `-` + 장비 코드 + 장비 번호 + `-` + 측정 종류(대문자, `_`는 `-`) | `H01-RK01-TEMP-IN` |
| MQTT 주소 | `dct/v1/` + 홀 + `/` + 장비 이름 + `/` + 측정 종류 (모두 소문자) | `dct/v1/hall01/rack_01/temp_in` |

장비 코드: rack = `RK`, crac = `CR`, pdu = `PD`

**변환 예시**
```
USD 경로  /DC/Hall01/Row01/Rack_01/Anchors/Sensor_TEMP_IN
  홀 = Hall01 → hall01, 홀 번호 01
  장비 = Rack_01 → rack_01, 코드 RK, 번호 01
  측정 종류 = temp_in
센서 ID   H01-RK01-TEMP-IN
MQTT 주소 dct/v1/hall01/rack_01/temp_in
```
- 장비 번호가 홀 안에서 겹치지 않기 때문에 줄(Row) 번호는 ID에 넣지 않는다.
- 이 변환은 코드 한 곳(센서 매니페스트 생성 스크립트, [이슈 #12](https://github.com/jangdave/DC-Twin/issues/12))에만 두고, 다른 곳에서는 변환을 다시 구현하지 않는다.

## 6. 장면 만들기: 참조와 덮어쓰기

장면 생성 스크립트가 에셋을 **참조(reference)** 해서 배치하고, 센서 앵커에 ID를 **덮어쓴다(override)**.

```usda
def Xform "Rack_01" (
    references = @../assets/rack.usda@
)
{
    double3 xformOp:translate = (-120, 0, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]

    over "Anchors"
    {
        over "Sensor_TEMP_IN"
        {
            string dct:sensorId = "H01-RK01-TEMP-IN"
        }
    }
}
```

| 장점 | 설명 |
|---|---|
| 에셋 하나를 고치면 모든 인스턴스가 바뀐다 | 랙 모델링을 개선해도 장면을 다시 만들 필요가 없다. |
| 센서 ID가 장면에만 있다 | 에셋은 어디서든 재사용할 수 있다. |
| 같은 설정이면 같은 결과 | 설정 파일과 스크립트만 있으면 장면을 다시 만들 수 있다. |

## 7. 재질

| 재질 이름 | 용도 |
|---|---|
| `M_RackFrame` | 랙 프레임 (어두운 금속) |
| `M_ServerBody` | 서버 몸체 |
| `M_ServerFront` | 서버 **앞면 패널**. 온도에 따라 색을 바꾸는 부분이므로 **반드시 별도 재질 칸**으로 둔다. |
| `M_Door` | 문틀 (검정 도장 금속) |
| `M_DoorPerf` | 문의 천공 철판(구멍은 텍스처) |
| `M_ServerHandle`, `M_CableBar`, `M_Caster`, `M_CasterWheel` | 손잡이, 케이블 정리 바, 캐스터와 바퀴 (단색) |
| `M_Crac*` (`Body`, `Plinth`, `Core`, `Return`, `Grille`, `Top`, `Supply`, `Handle`, `Display`, `LEDGreen`, `LEDAmber`) | CRAC 각 부분. 앞면 표시창과 표시등은 발광 재질 |

홀 내부 재질(랙, CRAC, 바닥, 벽, 천장, 격벽, 급기구, 조명)은 11.1.1를, 건물 외관 재질은 12장 표를 따른다. 외관은 **4096x4096 이미지 텍스처**를 연결한 재질을 쓴다(아래 12장).

- Blender의 Principled BSDF 재질은 USD로 나갈 때 `UsdPreviewSurface`로 바뀐다. 복잡한 노드는 바뀌지 않으므로 단순한 값(색, 금속성, 거칠기)만 쓴다.
- 온도 색 표시는 재질을 바꾸지 않고 Unreal에서 **인스턴스별 값**(Custom Primitive Data)으로 처리한다. ([12](12_unreal_design.md) 5장)

## 8. 속성 정리

| 속성 | 타입 | 붙는 곳 | 필수 |
|---|---|---|---|
| `dct:assetType` | token (`rack`, `server`, `crac`, `pdu`, `sensor`, `shell`, `containment`, `vent`, `building`, `outdoor`) | 장비, 센서 앵커, 에셋의 기본 prim | 필수 |
| `dct:sensorId` | string | 센서 앵커 (장면) | 장면에서 필수 |
| `dct:metric` | token | 센서 앵커 | 필수 |
| `dct:unit` | string | 센서 앵커 | 필수 |
| `dct:zone` | token (`cold_aisle`, `hot_aisle`) | 랙, 센서 앵커 | 선택 |
| `dct:title` | string | 건물(`Building`) | 건물에서 필수 |
| `dct:floor` | int (1 이상) | 홀, 건물의 층 표시 모양(`Floor_NN`) | 선택 |

Blender에서 사용자 속성으로 만들면 USD에는 string으로 나온다. `finalize_asset.py`가 `assetType`, `zone`, `metric`을 token으로 바꾼다.

## 9. 검증 규칙의 변경 (v1 → v2)

| 번호 | v1 | v2 |
|---|---|---|
| U203 | assetType 값: rack, server, crac, pdu | `sensor` 추가 |
| U401 | rack, crac, pdu에 `dct:sensorId` 필수 | rack, crac, pdu는 **센서 앵커를 하나 이상** 가져야 함 |
| U402 | 센서 ID 형식 | 센서 앵커의 센서 ID 형식, 그리고 **경로에서 만든 값과 같은지** |
| U403 | 센서 ID 중복 | 같음 |
| (새) U404 | - | 센서 앵커에 `dct:metric`, `dct:unit` 필수, 앵커 이름(`Sensor_<METRIC>`)과 `dct:metric` 일치 |

## 10. 에셋 목록

| 에셋 | 파일 | 상태 |
|---|---|---|
| 랙 | `usd/assets/rack.usda` + `usd/assets/textures/hall/` | 상세 모델링 완료(2026-10-15, 삼각형 4,436개, 메시 51개, 재질 9개). 틀, 문(천공), 케이블 바, 캐스터, 서버 10대와 앞면 텍스처. 센서 앵커 3개(v2 형식). 구조는 [10](10_modeling_guide.md) 12장 |
| CRAC | `usd/assets/crac.usda` | 상세 모델링 완료(2026-10-15, 90 x 100 x 220 cm, 삼각형 3,312개, 메시 26개, 재질 11개). 회수 격자, 패널 분할, 상단 덮개와 팬, 뒷면 급기 개구부. 센서 앵커 3개(v2 형식) |
| PDU | (파일 없음) | 만들지 않음. 현재 장면에 PDU가 없고 전력 센서는 랙마다 있다(ADR-009) |
| 건물 외관 | `usd/assets/building.usda` + `usd/assets/textures/building/` | 직접 모델링과 4K 텍스처 완료(2026-10-16 외벽을 유리 커튼월로 변경, 삼각형 약 16.1만, 메시 217개, 재질 16개). 만드는 방법은 12장 |
| 홀 내부(외피, 격벽, 급기구, 조명) | 별도 에셋 없음 | 장면 생성 스크립트(`build_scene.py` + `hall_interior.py`)가 재질과 UV가 있는 Mesh로 만든다(11.1.1). `--flat`이면 이전 상자 방식 |

## 11. 방(홀)과 둘러보기 규격 (초안 v2.1)

내부 둘러보기([12](12_unreal_design.md) 10장)를 위해 방을 걸어 다닐 수 있게 만들고, 안내 투어 지점을 USD로 정의한다. 검증 스크립트에는 이 규격이 확정된 뒤 반영한다.

### 11.1 홀 외피 (바닥, 벽, 천장)
데이터센터 내부가 곧 장면이므로 **방을 따로 모델링하지 않는다.** 걸어 다니는 데 필요한 바닥, 벽, 천장은 장면 생성 스크립트(`build_scene.py`, [이슈 #11](https://github.com/jangdave/DC-Twin/issues/11))가 **스크립트가 만든다.** 처음에는 기본 도형(상자)이었고, 2026-10-15에 재질과 UV가 있는 Mesh로 다듬었다(11.1.1).

| 항목 | 값 | 설명 |
|---|---|---|
| 홀 크기 | 11.0 x 13.6 x 4.0 m | 랙 6줄 x 10기 = 60기, CRAC 8기, 통로 포함. 값은 `usd/scenes/hall01.config.json`에서 정하고 이 문서를 고친다([ADR-009](decisions/ADR-009-hall-layout-and-cooling.md)). |
| 차가운 통로 폭 | 120 cm 이상 | 두 랙 줄의 서버 앞면 사이 |
| 뜨거운 통로 폭 | 100 cm 이상 | 두 랙 줄의 뒷면 사이 |
| 바닥 | 윗면에 타일 텍스처(60 cm 타일 이음선은 텍스처에 있다) | 이중 바닥 느낌은 텍스처로 표현. 급기구 천공 타일만 별도 형상 |
| 벽, 천장 | 상자 | 열 시뮬레이션의 막힌 곳 정보로도 쓴다([13](13_omniverse_research.md) 3장). |
| 조명 | 천장 조명 몇 개 | Unreal에서 설정해도 된다. |

홀 안의 구성 요소(`build_scene.py`가 만든다). 모두 `/DC/Hall01` 바로 아래에 둔다.

| 그룹 | 내용 | `dct:assetType` |
|---|---|---|
| `Row01`..`Row06` | 랙 60기(`Rack_01`..`Rack_60`). 줄 방향은 x축 | `rack` |
| `Cooling` | CRAC 8기. 짧은 벽 양쪽에 뜨거운 통로 끝과 같은 줄로 배치 | `crac` |
| `Shell` | 바닥, 벽 4개, 천장, 걸레받이, 바닥 표시, 조명 `Lights` | `shell` |
| `Containment` | 뜨거운 통로 격벽(지붕, 줄 끝 옆면 패널) | `containment` |
| `Vents` | 차가운 통로 바닥 급기구 30개 | `vent` |
| `Looks` | 재질(`UsdPreviewSurface`) 12개. 검증은 이름만 허용한다(U301) | (없음) |

- 랙의 앞면은 차가운 통로 쪽이다. 홀 y축 방향으로 `뜨거운 통로 - 줄 - 차가운 통로 - 줄 - 뜨거운 통로 ...` 순서로 쌓는다.
- 센서 앵커는 장비마다 `Anchors/Sensor_*` 로 두고 `dct:sensorId`는 장면에서 덮어쓴다(6장). 이번 장면의 센서는 랙 60 x 3 + CRAC 8 x 3 = 204개다.
- 나중에 Unreal에서 랙 배치를 바꾸고 시뮬레이션을 다시 돌릴 수 있도록, 배치의 원본은 설정 파일이고 시뮬레이션 입력은 장면 USD에서 읽는다.

### 11.1.1 홀 내부 형상과 재질 (2026-10-15)

`build_scene.py`가 `hall_interior.py`를 불러 만든다. 경로, 이름, `dct:assetType`, 위치와 크기는 이전 상자 버전과 같고(열 시뮬레이션이 읽는다), 모양과 재질만 바뀌었다. 모든 메시는 단면이고 격벽 유리만 양면이다. 텍스처는 `../assets/textures/hall/`(Git 제외, [10](10_modeling_guide.md) 12장으로 준비).

| prim (`/DC/Hall01/` 아래) | 구성 | 재질, 텍스처(실제 크기) |
|---|---|---|
| `Shell/Floor` | 슬래브 한 개. 윗면 z=0 | `M_HallFloor` = CC0 Tiles040 (480 cm 한 장에 타일 8 x 8, 타일 60 cm) |
| `Shell/Wall_West/East/South/North` | 벽 상자 4개 | `M_HallWall` = CC0 PaintedPlaster017 (400 x 200 cm) |
| `Shell/Ceiling` | 아랫면에 격자 텍스처 | `M_HallCeiling` = CC0 OfficeCeiling001 (360 cm 한 장에 6 x 6, 타일 60 cm) |
| `Shell/Skirting` | 걸레받이 4띠(8 cm) | `M_HallSkirting` (단색) |
| `Shell/Floor_Markings_Line`, `_Hazard` | 차가운 통로 양쪽 노란 선, CRAC 앞 줄무늬 띠(두께 0.6 cm) | `M_HallLine`(단색), `M_HallHazard` = 절차 생성 `T_HallHazard` (40 cm) |
| `Shell/Lights/Light_01..42` | 틀 + 발광 패널(광원 prim 없음). 차가운 통로 18개, 뜨거운 통로 24개 | `M_LightFrame`, `M_LightPanel`(발광) |
| `Containment/HotAisle_NN_*` | Xform(`containment`) 안에 `Frame`(알루미늄 틀)과 `Glass`(반투명 파란 패널) | `M_ContainFrame`, `M_ContainGlass`(불투명도 0.22) |
| `Vents/Vent_NN` | 50 x 100 x 1 cm 천공 타일(`vent`) | `M_VentTile` = 절차 생성 `T_VentTile` (50 x 100 cm 한 장, 열린 면적 약 21 %) |

- 바닥 타일 이음선은 **텍스처에만** 있고 형상에는 틈이 없다. 텍스처 시작점(`FLOOR_ORIGIN` = x 10, y 40 cm)은 랙 모서리(x 250 cm, 첫 줄 y 100 cm)가 이음선과 맞게 정했다. 다른 곳은 맞지 않는다.
- 천장 격자도 텍스처에만 있다. 조명 패널은 격자와 별개 형상이다.
- 삼각형: Shell 1,252 + Containment 1,296 + Vents 300 = 2,848. 장면 전체는 랙 60기(약 26.6만) + CRAC 8기(약 2.6만) + 위 2,848 = 약 29.6만으로 장면 예산(40만) 이하다.
- 이중 바닥 아래 받침 기둥은 모델링하지 않았다(바닥 슬래브 두께 20 cm, 단면 연출은 하지 않음).

### 11.2 충돌
- 외피(바닥, 벽, 천장)가 이미 상자라서 **그 자체를 충돌로 쓴다.** 별도 충돌 형상이 필요 없다.
- 랙은 에셋 안의 `Collision` 그룹에 상자(`Col_<대상>`)를 둘 수 있다. 필요한지는 Phase 2의 E1에서 확인한다(랙 외형이 단순해서 불필요할 수도 있다).

### 11.3 투어 앵커
안내 투어의 지점 하나는 **투어 앵커 prim** 하나다. `/DC/Hall01/Tour` 아래에 둔다.

```
/DC/Hall01/Tour
 ├─ View_01   (정문에서 본 홀 전체)
 ├─ View_02   (차가운 통로)
 └─ View_03   (냉각 장치 앞)
```

| 속성 | 타입 | 설명 |
|---|---|---|
| `dct:assetType` | token = `viewpoint` | 투어 앵커 표시 |
| `dct:title` | string | 지점 제목 (패널에 표시) |
| `dct:description` | string | 설명 |
| `dct:focus` | string (선택) | 강조할 장비 이름. 예: `CRAC_02` |
| 위치·방향 | Xform | 카메라가 서는 위치와 보는 방향 |

- 지점 순서는 이름의 번호 순서(`View_01`, `View_02`, ...)다.
- 투어 앵커는 센서 매니페스트와 같은 방식으로 **투어 목록 JSON**으로 뽑아 Unreal이 읽는다([ADR-005](decisions/ADR-005-sensor-anchors-and-manifest.md)의 방식을 확장).

## 12. 건물 외관과 층 (v2.2 초안, ADR-008)

첫 화면은 건물 외관이고 건물을 누르면 한 층(서버 랙 공간)으로 들어간다. **기존 `/DC/Hall01/...` 구조는 그대로 두고**, 건물을 옆에 추가한다. 센서 ID와 검증 규칙이 바뀌지 않게 하려는 것이다.

```
/DC
 ├─ Building01                       (assetType = building)
 │   ├─ Exterior                     (외벽, 지붕, 출입구, 환기구: 외관용 모양)
 │   ├─ Floors                       (층 표시용 단순 모양, 선택 가능한 층은 표시)
 │   └─ Outdoor                      (옥외 설비: 냉각탑, 발전기, 변전 설비)
 └─ Hall01                           (서버 랙 공간, 3층에 해당)
     └─ ... (3장의 구조 그대로)
```

| 속성 | 붙는 곳 | 설명 |
|---|---|---|
| `dct:assetType = "building"` | `Building01` | 건물. 클릭 대상 |
| `dct:title` | `Building01` | 화면에 표시할 이름 |
| `dct:floor` (정수) | `Hall01` | 이 홀이 있는 층 번호. 외관 화면에서 어느 층이 열리는지 정한다. |
| `dct:assetType = "outdoor"` | 옥외 설비 | 냉각탑, 발전기 등 |

- **자세히 만드는 층은 하나**(`Hall01`)이다. 다른 층은 외관 안쪽을 가린 단순 모양이며 누를 수 없다(화면에 "준비 중" 표시 없이 비활성).
- 건물 외관과 옥외 설비는 **직접 모델링**한다. 외벽은 모듈형 패널로 만들어 반복해 쓴다.
- 외관 모델은 걸어 다니지 않으므로 충돌 형상이 필요 없고, 열 시뮬레이션에도 쓰이지 않는다. 외관 정보는 보기 위한 모양이다.
- 검증 스크립트는 `building`, `outdoor`를 `dct:assetType` 허용 값에 추가하고, `/DC` 바로 아래에 `Hall##`과 `Building##`을 모두 허용하도록 고친다([이슈 #10](https://github.com/jangdave/DC-Twin/issues/10)).

### 12.1 건물 외관 에셋 (`building.usda`) 규격

가상 시설이다. 실제 시설의 형상, 도면, 로고, 상표, 간판 문구를 따라 하지 않았다. 설계의 근거는 [15 외관 레퍼런스](15_exterior_references.md)에 있다.

| 항목 | 값 |
|---|---|
| 기본 prim | `Building` (`dct:assetType = "building"`, `dct:title`). 장면에서는 `/DC/Building01`로 참조한다. |
| 원점, 방향 | 지면 중앙. 정문 방향이 -Y, 위쪽 +Z, 단위 cm |
| 건물 크기 | 72 x 45.6 m, 3층 x 4.8 m, 지붕면 높이 14.4 m (난간벽 위 15.4 m). 서버 랙 홀(11.0 x 13.6 x 4.0 m)이 3층 안에 들어간다. |
| 부지 | 울타리 안쪽 130 x 105 m (x -65~65 m, y -55~50 m). 정문(울타리 앞쪽 가운데 12 m)은 -Y. |
| 이 크기의 근거 | 공개 자료에서 본 "저층 대형 직육면체"의 느낌에 맞춰 **직접 정한 값**이다. 실제 시설의 치수가 아니다. |

```
Building                (assetType = building, title)
 ├─ Exterior            Plinth, WallCore, WallPanels, WallTrim, Louvers, ServiceDoors, Entrance,
 │                      RoofDeck, RoofEquipment, RoofScreens
 ├─ Floors              Floor_01, Floor_02, Floor_03   (dct:floor = 1, 2, 3. 외벽 안쪽에 들어가는 단순 상자)
 ├─ Outdoor             (assetType = outdoor)
 │    SiteGround, CoolingTower_01~04, CoolingPipes, Generator_01~08, FuelTanks, Substation,
 │    Fence, GateAndGuardHouse, LightPoles, Landscape     (각각 assetType = outdoor)
 └─ _materials
```

- `Hall01`은 3층(`dct:floor = 3`)에 둔다. `Floor_03` 상자가 홀을 덮는 자리이며, 외관 화면에서 층을 열 때 `Floors` 아래 상자를 숨기고 `Hall01` 서브레벨을 불러온다.
- 외벽(1~3층)은 **유리 커튼월**이다(2026-10-16 사용자 요청으로 금속 패널에서 변경). 1.2 x 2.4 m 칸마다 유리판(두께 3 cm)을 하나씩 만들고 알루미늄 창틀(`Mullions`)을 두른다. 환기 루버와 문 칸은 그대로 뚫려 있다. 난간만 금속 패널이다. 유리는 반사 코팅 유리처럼 보이게 금속성 0.55, 거칠기 0.04의 **불투명 재질**이다(안쪽 `WallCore`가 비치지 않는다). 속이 비치는 유리는 Unreal에서 투명 정렬 비용이 있어 쓰지 않았다.

#### 외관 재질과 텍스처 (4096 x 4096 PNG, 8비트, 타일링 가능)

| 재질 | 용도 | 텍스처 | 타일 크기 |
|---|---|---|---|
| `M_BldgPanelMetal` | 난간 금속 패널, 경비실, 차양 | `T_BldgPanelMetal_` BaseColor, Normal, Roughness, Metallic (+AO 파일, 재질에는 연결 안 함) | 4.8 m (패널 4열 x 2행) |
| `M_BldgConcrete` | 기초, 포장, 설비 바닥판, 수조 | `T_BldgConcrete_` BaseColor, Normal, Roughness | 4.0 m (줄눈 2 m 간격) |
| `M_BldgRoof` | 지붕 방수막 | `T_BldgRoof_` BaseColor, Normal, Roughness | 4.8 m (이음 1.2 m 간격) |
| `M_Asphalt` | 부지 바닥 | `T_Asphalt_` BaseColor, Normal, Roughness | 4.0 m |
| `M_BldgLouver`, `M_BldgGlass`, `M_BldgCurtainGlass`(외벽 유리), `M_BldgMullion`(유리 창틀), `M_BldgWallCore`, `M_BldgFan`, `M_BldgFloorProxy`, `M_OutdoorEquip`, `M_Fence`, `M_ParkingPaint`, `M_Foliage`, `M_Trunk` | 단색 재질(텍스처 없음) | - | - |

- 텍셀 밀도: 약 850~1020 픽셀/m. UV는 면마다 세계 길이를 타일 크기로 나눈 값이며, 늘어나지 않게 이어진다(타일 범위를 넘는 UV, 반복 설정 `repeat`).
- 노멀 맵 녹색 채널: **OpenGL 규약(녹색 = 위쪽이 +)** 으로 저장한다. Blender와 USD UsdPreviewSurface가 이 규약(`scale 2, bias -1`)을 쓴다. **Unreal은 DirectX 규약(녹색 = 아래쪽이 +)** 이므로 가져올 때 "Flip Green Channel"을 켜거나, 텍스처 생성 스크립트에 `--directx`를 붙여 다시 만든다. (Unreal 5.7에서 USD로 가져올 때 자동으로 뒤집히는지는 **확인하지 못했다.** Phase 5.5 때 확인한다.)
- 텍스처 원본 폴더는 `blender/textures/building/`(스크립트로 다시 만들 수 있어 저장소에 올리지 않음), USD가 쓰는 복사본은 `usd/assets/textures/building/`이다.
- 만드는 순서: 텍스처(`make_building_textures.py`) → 모델(`make_building_exterior.py`) → `export_usd.py ... --textures NEW` → `finalize_asset.py ... --textures-dir ...` ([10 모델링 가이드](10_modeling_guide.md) 11장).
