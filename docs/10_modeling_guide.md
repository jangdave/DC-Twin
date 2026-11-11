# 10. 모델링 가이드 (서버 랙)

- 상태: 채택 (2026-10-15)
- 목적: 서버 랙을 직접 모델링할 때 지킬 크기, 구성, 점검 항목, 내보내기 방법을 정한다.
- 읽는 사람: 모델링을 하는 사람. Blender를 쓸 수 있고 3D 모델링 경험이 많지 않아도 따라 할 수 있게 쓴다.
- 관련 문서: [09 USD 규격](09_usd_spec.md)

## 1. 토폴로지가 어려울까? (결론부터)

**이 프로젝트에서는 걱정하지 않아도 된다.** 토폴로지(면과 선이 이어진 방식)가 중요한 경우와 아닌 경우가 다르다.

| 토폴로지가 중요한 경우 | 이 프로젝트의 랙 |
|---|---|
| 캐릭터처럼 **휘어지는** 모델(관절, 표정) | 랙은 딱딱하고 움직이지 않는다. |
| 서브디비전으로 **부드럽게 만드는** 모델 | 쓰지 않는다. 각진 장비다. |
| 조각(스컬프팅)이나 리토폴로지가 필요한 모델 | 하지 않는다. |
| 애니메이션이 있는 모델 | 없다. 문도 움직이지 않는다. |

대신 **아래 항목이 결과 품질을 좌우한다.** 토폴로지보다 이쪽에 신경 쓴다.

| 중요한 것 | 이유 |
|---|---|
| 크기와 원점 | 장면에 놓았을 때 크기가 맞고 위치 계산이 쉬워야 한다. |
| 법선(면이 향하는 방향) | 뒤집히면 조명이 어둡게 나온다. |
| 삼각형 개수 | 랙 60기를 한 화면에 그려야 한다(처음 계획은 20기). |
| 이름과 재질 칸 | 스크립트와 Unreal이 이름으로 부품을 찾는다. |
| 모디파이어 적용 | 적용하지 않으면 내보낸 모양이 다를 수 있다. |

**만드는 방식은 "하드 서피스"**: 상자 같은 기본 도형을 키우고, 자르고, 모서리를 깎는(베벨) 방식이다. Blender의 모디파이어(어레이, 미러, 베벨, 불리언)로 대부분 만든다.

## 2. 크기와 구성

| 항목 | 값 | 설명 |
|---|---|---|
| 랙 외형 | 가로 60 x 깊이 100 x 높이 200 cm | 가상 값. 실제 제품 치수를 따라 하지 않는다. |
| 서버 1U | 4.445 cm | 19인치 랙의 공개 표준 높이 |
| 서버 폭 | 48.26 cm | 19인치의 표준 폭 |
| 원점 | 바닥 면의 중앙 | 배치할 때 편하다. |
| 앞쪽 | -Y 방향 | 서버 앞면이 -Y를 향한다. |
| Blender 단위 | 1 단위 = 1 cm | 블록아웃 파일이 이미 설정되어 있다. |

**꼭 있어야 하는 오브젝트**

| 이름 | 내용 | 비고 |
|---|---|---|
| `Rack` | 맨 위 빈 오브젝트. `assetType = rack` | 기본 prim이 된다. |
| `Frame_*` | 바닥판, 윗판, 기둥 | 이름 앞부분만 맞으면 된다. |
| `Server_U##` | 서버. 이름의 숫자는 시작 U | `assetType = server` |
| `Server_U##_Face` | 서버 앞면 패널 | `M_ServerFront` 재질 사용 |
| `Anchors/Sensor_*` | 센서 위치 표시 빈 오브젝트 | 사용자 속성 `metric` (09 규격 4장) |

선택: `Door_Front`, `Door_Rear`(구멍 뚫린 문), 케이블. 문은 움직이지 않는 모양만 만든다.

## 3. 삼각형 예산

| 대상 | 목표(측정 전 가정) | 현재 |
|---|---|---|
| 랙 1기 | 15,000개 이하(상세 모델은 30,000개 이하로 올림) | 블록아웃 312개 → 상세 4,436개 |
| 장면 전체(랙 60기 + 설비 + 방) | 400,000개 이하 | 미측정 |

- 목표는 **가정**이다. Unreal에서 실제 프레임 속도를 측정한 뒤(Phase 2) 조정한다.
- 확인 방법은 6장에 있다.
- 구멍이 많은 문이나 케이블이 삼각형을 많이 쓴다. 이런 부분은 **텍스처로 표현**하는 방법을 먼저 생각한다.

## 4. 모델링 순서

1. `blender/rack_blockout.blend`를 열고 **`blender/rack.blend`로 다른 이름으로 저장**한다. 프레임과 서버 10대가 있는 기준 모델이다. (블록아웃 파일은 원본으로 남겨 둔다.)
2. **크기와 원점은 바꾸지 않는다.** 세부만 더한다.
3. 프레임: 기둥에 베벨(모서리 깎기), 바닥판에 발이나 바퀴를 더한다.
4. 서버: 앞면에 손잡이, 환기구 줄, 표시등 같은 세부를 더한다. 서버 하나를 잘 만든 뒤 복사해서 쓴다. 복사할 때는 **연결 복제(Alt+D)** 로 모양 데이터를 공유하면 용량이 줄어든다.
5. 문(선택): 얇은 판에 구멍 패턴을 어레이 모디파이어로 만든다.
6. 재질: 4개(`M_RackFrame`, `M_ServerBody`, `M_ServerFront`, `M_Door`)만 쓴다. 단순한 값(색, 금속성, 거칠기)만 설정한다.
7. 6장의 점검 항목을 확인하고 내보낸다.

## 5. 해야 하는 일과 하지 않는 일

| 하는 일 | 하지 않는 일 |
|---|---|
| 모디파이어를 쓰고 **적용(Apply)** 한 뒤 내보내기 | 서브디비전 서피스 사용 |
| 스케일을 1로 맞추기 (Ctrl+A → 스케일 적용) | 조각(스컬프팅), 리깅, 애니메이션 |
| 4각형 위주로 만들기 | 5각 이상 면(n-gon)을 곡면에 쓰기 |
| 재질 칸 이름을 정해진 것만 쓰기 | 복잡한 재질 노드(절차적 텍스처 등) |
| 실제 장비가 아닌 **가상 장비**로 만들기 | 실제 제품 형상, 로고, 상표 따라 하기 |

## 6. 내보내기 전 점검표

| 번호 | 점검 | 확인 방법 |
|---|---|---|
| 1 | 모든 오브젝트의 스케일이 1이다 | 오브젝트 선택 → N 패널 → 스케일 |
| 2 | 랙의 원점이 바닥 중앙이다 | `Rack` 위치가 (0, 0, 0) |
| 3 | 크기가 60 x 100 x 200 cm 안에 있다 | 내보낸 뒤 검증 단계에서 크기 출력 |
| 4 | 면이 뒤집히지 않았다 | 오버레이 → 면 방향 → 모두 파란색 |
| 5 | 겹치는 점이 없다 | 편집 모드 → 점 선택 → 거리로 병합 |
| 6 | 이름이 규칙대로다 | 아웃라이너 확인 |
| 7 | 재질이 4개 이하이고 이름이 규칙대로다 | 재질 탭 |
| 8 | 삼각형 수가 예산 이내다 | 뷰포트 통계(오버레이 → 통계) 또는 내보낸 뒤 스크립트 출력 |
| 9 | 센서 앵커가 있고 `metric` 속성이 있다 | 아웃라이너 → 오브젝트 속성 → 사용자 속성 |
| 10 | 모디파이어를 모두 적용했다 | 수정자 탭이 비어 있거나 의도한 것만 남음 |

## 7. 내보내기와 검증

저장소 루트에서 다음 순서로 실행한다. (Blender 설치 경로가 다르면 경로를 바꾼다.)

```
# 1) Blender에서 USD로 내보내기
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b blender\rack.blend --python blender\scripts\export_usd.py -- usd\assets\_rack_raw.usd

# 2) 규칙에 맞게 마무리 (scripts\usd_tools 폴더에서)
cd scripts\usd_tools
uv run --python 3.13 python finalize_asset.py ..\..\usd\assets\_rack_raw.usd ..\..\usd\assets\rack.usda

# 3) 검증
uv run --python 3.13 python validate_usd.py --kind asset ..\..\usd\assets\rack.usda
```
- `_rack_raw.usd`는 중간 파일이라 Git에 올리지 않는다(`.gitignore`에 이미 등록).
- 3번이 통과해야 한다. 실패하면 오류 번호와 메시지를 보고 모델을 고친다.

## 8. 시작 파일 다시 만들기

블록아웃이 망가졌거나 처음부터 다시 하고 싶으면 스크립트로 다시 만든다.
```
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --factory-startup --python blender\scripts\make_rack_blockout.py -- blender\rack_blockout.blend
```

## 9. 막혔을 때
| 증상 | 확인할 것 |
|---|---|
| 내보낸 크기가 다르다 | 스케일 적용 여부, 부모-자식 관계에서 위치가 두 번 더해지지 않았는지(블록아웃 스크립트에서 이미 한 번 겪은 문제) |
| 조명이 이상하게 어둡다 | 면 방향(법선) 확인 |
| 검증에서 `U202` | 장비 이름(`Server_U##` 등)인데 `assetType`이 없다 |
| 검증에서 `U203` | `assetType` 값이 허용 목록에 없다 |
| 재질이 회색으로 보인다 | 재질 노드를 Principled BSDF 하나로 단순화 |

## 10. 홀 외피와 둘러보기를 위한 주의 (Phase 2)

내부 둘러보기([12](12_unreal_design.md) 10장)에서는 **데이터센터 내부가 곧 장면**이라서, 방을 따로 모델링하지 않는다. 바닥, 벽, 천장은 장면 생성 스크립트가 상자로 만든다([09](09_usd_spec.md) 11장).

모델링하는 사람이 신경 쓸 점은 두 가지다.
- 랙을 눈높이에서 가까이 보므로 **서버 앞면과 문의 세부가 눈에 띈다.** 삼각형 예산 안에서 앞면 세부를 우선한다.
- 통로 폭(냉기 통로 120 cm 이상, 열기 통로 100 cm 이상)은 랙의 **깊이와 배치 간격**으로 정해지므로, 랙 외형 치수(60 x 100 x 200 cm)를 바꾸면 배치 설정도 다시 확인한다.

## 11. 건물 외관 만들기 (2026-10-15 추가)

랙과 달리 건물 외관은 **스크립트 하나로 모델 전체를 다시 만든다.** 형상을 손으로 고치지 말고 `make_building_exterior.py`를 고쳐서 다시 실행한다. 규격은 [09 USD 규격](09_usd_spec.md) 12.1장.

| 순서 | 할 일 | 명령 (저장소 루트에서) |
|---|---|---|
| 0 | CC0 텍스처 내려받기(콘크리트, 아스팔트) | `uv run --python 3.13 --with numpy --with pillow python scripts/fetch_cc0_textures.py` |
| 1 | 4K 텍스처 만들기(패널, 지붕. 약 15초) | `uv run --python 3.13 --with numpy --with pillow python blender/scripts/make_building_textures.py` |
| 2 | 이음새 확인 이미지 만들기 | `uv run --python 3.13 --with numpy --with pillow python blender/scripts/check_texture_tiling.py` |
| 3 | 모델 만들기 (삼각형 수가 출력됨) | `blender -b --factory-startup --python blender/scripts/make_building_exterior.py -- blender/building_exterior.blend` |
| 4 | USD로 내보내기 (텍스처 복사 포함) | `blender -b blender/building_exterior.blend --python blender/scripts/export_usd.py -- <스크래치>/building_raw.usd --textures NEW` |
| 5 | 마무리 (`scripts/usd_tools`에서, 텍스처는 `.jpg`와 `.png`를 모두 복사한다) | `uv run --python 3.13 python finalize_asset.py <스크래치>/building_raw.usd ../../usd/assets/building.usda --textures-dir ../../usd/assets/textures/building --textures-rel textures/building` |
| 6 | 검증 | `uv run --python 3.13 python validate_usd.py --kind asset ../../usd/assets/building.usda` |
| 7 | 미리보기 렌더(검수용) | `blender -b blender/building_exterior.blend --python blender/scripts/render_building_previews.py -- blender/previews 24` |

### 저장소를 받은 뒤 텍스처 준비하기 (4K 텍스처는 저장소에 올리지 않는다)
4K 텍스처(약 250 MB)는 저장소에 올리지 않는다(`usd/assets/textures/`는 `.gitignore`에 있다). 패널과 지붕은 **생성 스크립트가 시드를 고정해 같은 결과를 만들고**, 콘크리트와 아스팔트는 **CC0 실사 텍스처(ambientCG)** 를 내려받는다. `building.usda`는 `./textures/building/*`를 상대 경로로 참조하므로 저장소를 받은 뒤 한 번 준비한다.

```
uv run --python 3.13 --with numpy --with pillow python scripts/fetch_cc0_textures.py
uv run --python 3.13 --with numpy --with pillow python blender/scripts/make_building_textures.py
New-Item -ItemType Directory -Force usd/assets/textures/building | Out-Null
Copy-Item blender/textures/building/* usd/assets/textures/building/ -Exclude *_AO.png
```
- 첫 줄: CC0 텍스처 2개를 내려받는다(약 230 MB, 라이선스와 크기는 `blender/textures/cc0_sources.json`, 출처 기록은 [ASSET_LICENSES](ASSET_LICENSES.md)).
- 둘째 줄: 패널과 지붕 4K 텍스처를 만든다(약 15초). 셋째, 넷째 줄: AO를 뺀 파일을 USD가 찾는 위치로 복사한다. AO는 USD 재질에 연결하지 않았고 Unreal에서 쓸 수 있게 남겨 둔 파일이다.
- 텍스처가 없으면 `building.usda`는 열리지만 재질이 회색으로 보인다.

### 건물 부품 구조 (파트별로 분리, 2026-10-15)
같은 종류의 부품을 한 메시로 합치면 Unreal에서 하나씩 고르거나 가리거나 재질을 바꿀 수 없다. 그래서 **부품마다 메시 하나**로 만들고 종류별로 그룹(Xform)에 묶는다. 메시는 217개, 삼각형 합계는 160,852개다(외벽을 유리 커튼월로 바꾸기 전에는 205개, 138,316개). 이름은 `<그룹>_<부품>`이다.

| 그룹(`Building/` 아래) | 부품 이름 예 | 개수 |
|---|---|---|
| `Exterior` 바로 아래 | `WallCore`(벽 속 면), `RoofDeck`(지붕 바닥) | 2 |
| `Exterior/WallPanels` | `WallPanels_South_Parapet` (벽 4개의 난간만 금속 패널) | 4 |
| `Exterior/CurtainGlass`, `Exterior/Mullions` | `CurtainGlass_South_F1`, `Mullions_South_F1` (벽 4 x 1~3층의 유리판과 창틀) | 12, 12 |
| `Exterior/WallTrim` | `Band_<벽>_<층>`(층 경계 띠), `CornerPost_NE`(모서리 기둥), `Coping_<벽>`(난간 덮개) | 16 |
| `Exterior/Louvers` | `Louvers_West_02_R1` (벽, 시작 칸, 층) | 42 |
| `Exterior/ServiceDoors`, `Entrance`, `Plinth`, `RoofScreens` | `ServiceDoors_North_14`, `Entrance_Glass/Frame/Canopy/Columns/Paving/Bollard_01`, `Plinth_South`, `RoofScreens_North` | 4, 12, 4, 2 |
| `Exterior/RoofEquipment` | `Chiller_01~20`, `ExhaustStack_01~08`, `StairHouse_01~02`, `MechRoom_01`, `LightningRod_01~04`, `RoofPipe_North/South` | 37 |
| `Floors` | `Floor_01~03`(층 표시용 단순 모양) | 3 |
| `Outdoor/SiteGround` | `Asphalt`, `Pavement_Building`, `Walkway_Entrance`, `Pad_CoolingTowers/Generators/Substation/FuelTanks`, `ParkingLines_East/West`, `Crosswalk`, `Curb_East/West` | 12 |
| `Outdoor/CoolingTowers`, `Generators`, `FuelTanks`, `Substation` | `CoolingTower_01~04`+`CoolingPipes`, `Generator_01~08`, `FuelTank_01~02`, `Transformer_01~04`+`Gantry` | 5, 8, 2, 5 |
| `Outdoor/Fence`, `GateAndGuardHouse`, `LightPoles`, `Landscape` | `Fence_South_West/East/North/West`, `Posts/Leaf_West/Leaf_East/Rail/GuardHouse/Barrier`, `LightPole_01~12`, `Hedge_East/West`+`Tree_01~10` | 5, 6, 12, 12 |

- 부품 이름과 그룹은 `make_building_exterior.py`의 `Parts` 도우미가 만든다. 새 부품을 추가할 때는 `Parts("그룹", 목록)("부품")`으로 얻은 메시에 도형을 더한다.
- 같은 종류가 여러 개인 설비(냉각기, 발전기, 나무)는 개수만큼 메시가 생긴다. 같은 모양의 반복이라 이후에 인스턴스로 바꾸면 용량을 줄일 수 있다(지금은 하지 않았다).

### 텍스처와 형상을 맞추는 원칙 (노이즈를 막는다)
1. **중복하지 않는다.** 형상에 이미 있는 디테일(패널 틈, 루버 슬랫, 난간)을 텍스처에 또 그리지 않는다. 우리 패널은 틈을 형상으로 만들었으므로 텍스처는 이음선이 없는 평평한 면이 맞고, 골판 텍스처는 맞지 않는다.
2. **실제 크기를 맞춘다.** 텍스처의 실제 크기(아스팔트 250 cm, 콘크리트 240 cm)를 UV 타일 크기(`TS_ASPH`, `TS_CONC`)와 같게 둔다. 어긋나면 골재 알갱이가 거인이나 개미 크기로 보인다.
3. **큰 것은 형상, 작은 것은 텍스처.** 베벨, 틈, 슬랫은 형상이고 질감, 얼룩은 텍스처다.
4. **노멀의 세기를 제한한다.** 노멀 맵의 평균 기울기가 0.3을 넘으면 먼 거리에서 반짝이는 노이즈가 된다(2026-10-15: 절차 아스팔트 0.62, 콘크리트 0.34로 측정). CC0 아스팔트는 0.40이라 0.6배로 줄여 0.24로 썼다(`cc0_sources.json`의 `normal_strength`).
5. **같은 평면에 면을 겹치지 않는다.** 같은 방향의 면이 같은 평면(0.5 cm 이내)에 겹치면 서로 깜빡이는 노이즈(z-파이팅)가 된다. 예: 벽 속 면(`WallCore`)이 난간 높이까지 올라가 패널 안쪽 면과 겹쳤다. 다음 검사로 찾는다.
```
cd scripts/usd_tools
uv run --python 3.13 python check_coplanar_faces.py ../../usd/assets/building.usda --z-min 1380
```
   - 맞붙은 반대 방향 면(패널 뒷면과 벽 앞면)은 단면 렌더에서 보이지 않아 세지 않는다. 모든 메시는 단면(`doubleSided=False`)으로 내보내고 유리(`Entrance`)만 양면이다.
   - 삼각형 부채꼴 면은 오탐이라 제외한다.

- 길이는 스크립트 안에서 **미터**로 쓰고, 만들 때 100배(cm)한다.
- 삼각형 예산: 건물 전체 200만 이하(Nanite 사용 전제). 2026-10-15 기준 약 13.8만.
- 7번 렌더는 Blender 안에서 **상대 경로**로 저장하면 드라이브 루트(`C:\blender\...`)에 써 버리므로 스크립트가 절대 경로로 바꾼다.

## 12. 랙, CRAC, 홀 내부 상세 모델 (2026-10-15 추가)

- 상태: 채택. 목적: 서버 홀 안을 눈높이에서 볼 때 필요한 랙, CRAC, 바닥, 벽, 천장, 격벽, 급기구, 조명을 사실적으로 다듬고 다시 만드는 순서를 남긴다.
- 조사한 레퍼런스(공통 특징): [16 내부 레퍼런스](16_interior_references.md). 규격: [09](09_usd_spec.md) 11.1.1.
- **바꾸지 않은 것**(열 시뮬레이션 `hall60_sim.py`가 읽는다): 랙 60 x 100 x 200 cm, CRAC 90 x 100 x 220 cm, 앞면 방향(-Y), 센서 앵커, prim 경로와 `dct:assetType`, 급기구 50 x 100 cm(바닥 위 1 cm), 격벽 지붕 z 200~205 cm와 옆면 패널 두께 5 cm. 문 손잡이처럼 튀어나온 것은 경계 상자 **안쪽**에 둔다.

### 12.1 랙 (`blender/scripts/make_rack_detailed.py` → `usd/assets/rack.usda`)
부품마다 메시 하나이고 종류별 그룹(Xform)으로 묶는다(`Parts` 도우미 방식). 삼각형 4,436개, 메시 51개, 재질 9개.

| 그룹(`Rack/` 아래) | 부품 이름 | 내용 |
|---|---|---|
| `Frame` | `Base`, `Top`, `Post_01~04`, `Panel_L/R`, `Rail_Front_L/R`, `Rail_Rear_L/R` | 틀. 모서리를 깎은(베벨 0.5~0.6 cm) 상자. 옆판은 기둥보다 0.6 cm 안쪽. 19인치 장착 레일 |
| `Door` | `Front`, `Front_Handle`, `Rear_L`, `Rear_R`, `Rear_Handle` | 앞문 한 짝, 뒷문 두 쪽. 문틀(형상)과 천공 판(텍스처 `T_RackDoor`)을 한 메시에 재질 두 칸으로 둔다. 손잡이는 가장 앞쪽이 y -49.7 cm |
| `CableBar` | `V_Left`, `V_Right`, `H_07`, `H_19`, `H_24`, `H_31` | 세로 손가락형 케이블 정리 바(뒤쪽 좌우), 서버가 없는 U에 앞면 가로 정리 바(홈 8개) |
| `Caster` | `FL`, `FR`, `RL`, `RR`, `*_Wheel` | 아래 바퀴(받침판, 포크, 바퀴) |
| (Rack 바로 아래) | `Server_U01` … `Server_U30` | 서버 10대. 이름, 위치, `assetType=server`는 블록아웃과 같다. 몸통은 폭 44.5 cm |
| `Server_U##` 아래 | `Server_U##_Face` | 앞면 패널(`M_ServerFront`). 환기 구멍, 드라이브 칸, 표시등은 텍스처, 귀 손잡이는 형상 |
| `Anchors` | `Sensor_TEMP_IN`, `Sensor_TEMP_OUT`, `Sensor_POWER` | 센서 앵커(블록아웃과 같은 자리) |

- 서버 앞면 텍스처 한 장 = 가로 48.26 cm(19인치 폭) x 세로 8U(35.56 cm). 1U(512 px)마다 무늬가 달라서 여러 U짜리 서버는 1U 칸이 쌓여 보인다.
- 형상에 있는 것(문틀, 손잡이, 정리 바)은 텍스처에 다시 그리지 않았다. 구멍과 표시등처럼 작은 것만 텍스처다.

### 12.2 CRAC (`make_crac_detailed.py` → `usd/assets/crac.usda`)
삼각형 3,312개, 메시 26개, 재질 11개.

| 그룹(`CRAC/` 아래) | 부품 | 내용 |
|---|---|---|
| `Base` | `Plinth`, `Core` | 받침(90 x 100 x 10 cm, 바깥 크기를 정한다)과 속(어두운 몸통) |
| `Side` | `Panel_L_01~03`, `Panel_R_01~03` | 옆 패널 3분할(틈 0.4 cm) |
| `Front` | `Panel_Low`, `Panel_Up`, `Handle_L/R`, `Status` | 앞 패널 위아래, 손잡이, 상태 표시창과 표시등(발광) |
| `Return` | `Frame`, `Grille`, `Back` | 회수 격자: 틀, 가로 살 28장, 뒤쪽 어두운 판 |
| `Top` | `Cover`, `Fan_Ring`, `Fan_Spokes`, `Fan_Hub` | 상단 덮개와 팬 덮개 |
| `Rear` | `Panel_Up`, `Panel_Low_L/R`, `Supply_Frame`, `Supply_Grille`, `Supply_Back` | 뒷면과 하부 급기 개구부(파란 틀). 찬 공기가 이중 바닥으로 나가는 곳 |
| `Anchors` | `Sensor_SUPPLY_TEMP`(뒷면 아래), `Sensor_RETURN_TEMP`(앞면), `Sensor_FAN_SPEED`(위) | 센서 앵커(블록아웃과 같은 자리) |

### 12.3 홀 내부 (장면)
홀 외피, 격벽, 급기구, 조명은 `scripts/usd_tools/hall_interior.py`가 `build_scene.py` 안에서 만든다(Blender를 쓰지 않는다). 부품 목록과 재질은 [09](09_usd_spec.md) 11.1.1 표. 이전 상자 방식이 필요하면 `build_scene.py ... --flat`.

### 12.4 텍스처
| 종류 | 이름 | 만드는 방법 | 실제 크기 | 쓰는 곳 |
|---|---|---|---|---|
| CC0 (ambientCG) | `T_HallFloor_*` (Tiles040) | 내려받기 | 480 cm = 타일 8 x 8(60 cm) | 바닥 |
| CC0 | `T_HallWall_*` (PaintedPlaster017, 4096 x 2048) | 내려받기 | 400 x 200 cm(눈으로 정함) | 벽 |
| CC0 | `T_HallBlackMetal_*` (Metal027) | 내려받기 | 100 cm(눈으로 정함) | 랙 틀, 문틀 |
| CC0 | `T_HallCeiling_*` (OfficeCeiling001) | 내려받기 | 360 cm = 타일 6 x 6(60 cm) | 천장 |
| 절차 생성 | `T_RackDoor_*` | `make_hall_textures.py` | 60 cm | 문 천공 철판(열린 면적 56 %) |
| 절차 생성 | `T_ServerFront_*`(+발광) | 같음 | 48.26 x 35.56 cm | 서버 앞면 |
| 절차 생성 | `T_VentTile_*` | 같음 | 50 x 100 cm | 급기 타일(열린 면적 21 %) |
| 절차 생성 | `T_HallHazard_*` | 같음 | 40 cm | 바닥 안전 표시 |
| 절차 생성 | `T_CracPaint_*` | 같음 | 100 cm | CRAC 도장 |

- 모두 4096 x 4096이다(벽 CC0만 4096 x 2048). 노멀 평균 기울기는 절차 생성 텍스처가 0.03~0.20으로 0.3 이하다. CC0는 `normal_strength`(0.4~0.5)로 줄였다.
- 바닥 타일 이음선과 천장 격자는 텍스처에만 있고 형상에는 없다(규칙 1). 급기 천공 타일은 형상(타일 한 장)과 텍스처(구멍)가 역할이 다르다.

### 12.5 다시 만드는 순서 (저장소 루트에서)
```
# 0) 텍스처 (4K 파일은 저장소에 없다. 약 250 MB, 30초 + 내려받기 시간)
uv run --python 3.13 --with numpy --with pillow python scripts/fetch_cc0_textures.py --sources blender/textures/cc0_sources_hall.json --out blender/textures/hall
uv run --python 3.13 --with numpy --with pillow python blender/scripts/make_hall_textures.py

# 1) 랙, CRAC: Blender 모델 -> USD -> 마무리 -> 검증, 텍스처 복사까지 한 번에
powershell -File scripts/build_hall_assets.ps1

# 2) 장면
cd scripts/usd_tools
uv run --python 3.13 python build_scene.py ../../usd/scenes/hall01.config.json ../../usd/scenes/hall01.usda
uv run --python 3.13 python validate_usd.py ../../usd/scenes/hall01.usda
uv run --python 3.13 python check_coplanar_faces.py ../../usd/scenes/hall01.usda      # 다른 메시 사이 겹침 0이어야 한다

# 3) 미리보기(검수용, Blender가 장면을 읽는다. 장면 경로는 절대 경로)
blender -b --factory-startup --python blender/scripts/render_hall_previews.py -- <저장소 절대 경로>/usd/scenes/hall01.usda blender/previews 32

# 4) 열 시뮬레이션이 읽는 값이 그대로인지(작업 전후 비교)
cd experiments/omniverse_probe
uv run --python 3.13 python dump_hall_layout.py        # out/hall60/layout.json의 랙, CRAC, 급기구, 격벽 min/max를 전후 비교(허용 0.1 cm)
uv run --python 3.13 python hall60_sim.py --duration 120 --fail-time 60 --every 60   # 격자 110 x 136 x 40이어야 한다
```
- `scripts/build_hall_assets.ps1`은 Blender 경로가 다르면 `-Blender`로 준다. `.blend`(`blender/rack.blend`, `crac.blend`)는 원본으로 남긴다. 블록아웃 파일(`*_blockout.blend`)은 그대로 있다.
- 시뮬레이션 확인 명령은 `out/hall60/` 아래 추적 중인 결과 파일을 덮어쓴다. 확인만 할 때는 끝나고 `git checkout -- experiments/omniverse_probe/out`로 되돌린다.
