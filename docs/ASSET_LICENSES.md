# 외부 에셋 출처/라이선스

직접 제작하지 않은 에셋(텍스처, HDRI, 폰트 등)은 아래에 기록한다.

| 에셋 | 출처 URL | 라이선스 | 사용 위치 |
|---|---|---|---|
| **Asphalt033** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기. 노멀 기울기를 0.6배로 줄여 저장) | https://ambientcg.com/a/Asphalt033 (압축 파일 SHA-256 `a7fbd2e2e8016716d37d03532ccf4e52b93cff338f0f6db5f3e54a0dbcf0489f`) | CC0 1.0 Universal (https://docs.ambientcg.com/license/ 에서 2026-10-15 확인). 출처 표기는 필수가 아니지만 권장됨: "Created using Asphalt033 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal" | 건물 외관의 부지 바닥(`T_Asphalt_*`) |
| **Concrete046** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기) | https://ambientcg.com/a/Concrete046 (압축 파일 SHA-256 `ca5757af54176e96add5a5440efd9672885d6dee271070ccef496e64c3a9ce93`) | CC0 1.0 Universal (위와 같음). Created using Concrete046 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal | 건물 외관의 기초, 포장, 설비 받침(`T_BldgConcrete_*`) |
| **Tiles040** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기. 노멀 기울기 0.5배) | https://ambientcg.com/a/Tiles040 (압축 파일 SHA-256 `f918a673602b63723fce1f32bf79feb15a74d19b4113dae98828be4fb9eb72cc`) | CC0 1.0 Universal (https://docs.ambientcg.com/license/ 에서 2026-10-15 확인). Created using Tiles040 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal | 서버 홀 바닥(`T_HallFloor_*`) |
| **PaintedPlaster017** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기. 노멀 기울기 0.5배. 4096 x 2048) | https://ambientcg.com/a/PaintedPlaster017 (압축 파일 SHA-256 `7843456207e8b5cac4b44d0583e46fead88c46c28a615895dd79341b24083f9e`) | CC0 1.0 Universal (위와 같음). Created using PaintedPlaster017 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal | 서버 홀 벽(`T_HallWall_*`) |
| **Metal027** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기, 금속성. 노멀 기울기 0.4배) | https://ambientcg.com/a/Metal027 (압축 파일 SHA-256 `62da90f682e1ff09daa21e95737cd5ba1d14ce3f22fea355a2c9ee8547f6a614`) | CC0 1.0 Universal (위와 같음). Created using Metal027 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal | 랙 프레임, 문틀(`T_HallBlackMetal_*`) |
| **OfficeCeiling001** (ambientCG, 4K-JPG: 색, 노멀 GL, 거칠기. 노멀 기울기 0.5배) | https://ambientcg.com/a/OfficeCeiling001 (압축 파일 SHA-256 `de64bed7f1d29ed99af271a7d243f51233fee090ef3a07d40919070fdf7dca60`) | CC0 1.0 Universal (위와 같음). Created using OfficeCeiling001 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal | 서버 홀 천장(`T_HallCeiling_*`) |

- 위 여섯 개는 **저장소에 올리지 않는다.** `scripts/fetch_cc0_textures.py`가 ambientCG에서 내려받아 `blender/textures/building/`에 놓는다(목록: `blender/textures/cc0_sources.json`). 실제 크기는 아스팔트 250 cm, 콘크리트 240 cm이며 `make_building_exterior.py`의 타일 크기와 같다.
- 서버 홀 내부용 네 개(Tiles040, PaintedPlaster017, Metal027, OfficeCeiling001)는 같은 스크립트에 `--sources blender/textures/cc0_sources_hall.json --out blender/textures/hall`을 주어 받는다. 파일 이름 접두와 실제 크기는 그 목록에 있다. 실제 크기를 ambientCG가 알려 주지 않은 것은 눈으로 정했고(바닥은 타일 한 장을 60 cm로 보고 480 cm, 벽 200 cm, 금속 100 cm), 목록의 `tile_cm_source`에 근거를 적었다. 천장은 자산 정보 385 cm 대신 타일 60 cm에 맞춰 360 cm로 썼다.
- 라이선스는 ambientCG 라이선스 페이지(https://docs.ambientcg.com/license/)에서 2026-10-15에 CC0 1.0 Universal임을 확인했다. 내려받은 압축 파일은 신뢰할 수 없는 데이터라 이미지만 꺼내 쓰고 실행하지 않는다.

## 직접 제작한 에셋 (외부 출처 없음)

외부에서 내려받은 이미지, 텍스처, 모델은 쓰지 않았다. 아래는 모두 이 저장소의 스크립트로 만든 것이다.

| 에셋 | 만든 방법 | 라이선스 | 사용 위치 |
|---|---|---|---|
| 건물 외관 4K 텍스처 (패널 `T_BldgPanelMetal_*`, 지붕 `T_BldgRoof_*`, 각 4096x4096 PNG. 콘크리트와 아스팔트는 위 CC0 텍스처로 바꿨고, 절차 생성 버전은 `--only concrete,asphalt`로 만들 수 있는 대체용) | **직접 제작, 절차적 생성.** `blender/scripts/make_building_textures.py`가 numpy의 푸리에 변환 잡음(이음새 없이 이어지는 주기적 잡음)과 수식으로 색, 높이, 거칠기, 금속성을 계산하고 Pillow로 PNG로 저장한다. 사진이나 외부 이미지를 쓰지 않았다. 시드가 고정되어 같은 결과가 다시 만들어진다. | 이 저장소의 라이선스를 따른다 (직접 제작) | `usd/assets/building.usda` |
| 서버 홀 내부 4K 텍스처 (랙 문 `T_RackDoor_*`, 서버 앞면 `T_ServerFront_*`(발광 포함), 바닥 안전 표시 `T_HallHazard_*`, 급기 타일 `T_VentTile_*`, CRAC 도장 `T_CracPaint_*`, 각 4096x4096 PNG) | **직접 제작, 절차적 생성.** `blender/scripts/make_hall_textures.py`가 numpy와 Pillow로 만든다. 외부 이미지를 쓰지 않았고 글자와 로고가 없다. 시드가 고정되어 같은 결과가 다시 만들어진다. | 이 저장소의 라이선스를 따른다 (직접 제작) | `usd/assets/rack.usda`, `crac.usda`, 장면 `hall01.usda` |
| 랙, CRAC 상세 3D 모델과 홀 내부 형상 (`blender/scripts/make_rack_detailed.py`, `make_crac_detailed.py`, `scripts/usd_tools/hall_interior.py`) | **직접 제작.** 가상 장비이며 실제 제품의 형상, 로고, 상표, 라벨 문구를 따라 하지 않았다. 레퍼런스는 공통 특징만 참고했다([16](16_interior_references.md)). | 이 저장소의 라이선스를 따른다 (직접 제작) | 홀 내부 화면 |
| 건물 외관 3D 모델 (`blender/building_exterior.blend`, `usd/assets/building.usda`) | **직접 제작.** `blender/scripts/make_building_exterior.py`가 Blender로 형상을 만든다. 가상 시설이며 실제 시설의 형상, 도면, 로고, 상표를 따라 하지 않았다. 레퍼런스는 공통 특징만 참고했다([15](15_exterior_references.md)). | 이 저장소의 라이선스를 따른다 (직접 제작) | 외관 화면 |
| 웹 보기 화면용 장비 모양 `web/viewer/public/models/{rack,crac}.glb` | **직접 제작.** `blender/rack.blend`, `crac.blend`를 `blender/scripts/export_glb.py`로 내보냈다. 텍스처를 넣지 않았고 재질 색은 스크립트에 직접 적은 값이다(외부 이미지 없음) | 이 저장소의 라이선스를 따른다 (직접 제작) | 웹 보기 화면 |

## 웹 외관 환경 (2026-11-03)
- `web/viewer/public/models/building.glb`: `blender/building_exterior.blend`(직접 모델링)에서 `blender/scripts/export_building_glb.py`로 내보낸 건물과 옥외 설비. 콘크리트, 외벽 패널, 지붕, 아스팔트의 기본색 그림을 1K로 줄여 넣었다. 원본은 `blender/textures/building/`이고, 출처는 직접 절차적으로 만든 것(`blender/scripts/make_building_textures.py`)과 ambientCG CC0 자료(`blender/textures/cc0_sources.json`)이다. Draco 압축 해제기(`public/draco/`)는 three.js 예제의 파일이며 MIT 라이선스다.
- 하늘, 구름, 먼 언덕, 풀밭은 `web/viewer/src/env.js`가 코드로 만든다. 외부 이미지를 쓰지 않는다.
- `web/viewer/public/data/flow.bin`, `flow.json`: 우리 솔버(`experiments/omniverse_probe/hall60_sim.py`)가 홀 장면에서 계산해 `export_web_flow.py`로 내보낸 속도장. 외부 데이터 없음.

## 웹 도심 배경 (2026-11-03)
- `web/viewer/src/city.js`가 상자 건물, 도로, 가로수, 차량, 창 무늬(캔버스)를 코드로 만든다. 외부 에셋과 외부 이미지는 없다. 가상의 도시이며 실제 지역을 본뜨지 않았다.

## 웹 글꼴과 디자인 토큰 (2026-11-03)
- `web/viewer/public/fonts/subset/`: Pretendard Variable 동적 부분 집합(92조각). SIL Open Font License 1.1, 저작권 Kil Hyung-jin 등. 원본 https://github.com/orioncactus/pretendard (npm `pretendard@1.3.9`). 라이선스 전문은 `web/viewer/public/fonts/LICENSE-Pretendard.txt`.
- `web/viewer/src/tokens.css`: Figma "[Platform] DT Design System"의 변수(색, 글자 크기, 모서리, 간격, 그림자) 값. 디자인 시스템 파일의 아이콘, 이미지, 회사 로고와 이름은 가져오지 않았다.
