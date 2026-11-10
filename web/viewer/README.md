# 웹 보기 화면 (DC-Twin Viewer)

Unreal 클라이언트와 별도로 만든, 브라우저에서 보기만 하는 가벼운 3D 화면이다. 랙 입구 온도, 알람, 보정 모델(AI 대리 모델)의 90% 구간과 신뢰 등급을 보여 준다. 기능명세는 [docs/18](../../docs/18_web_viewer_spec.md), 결정 이유는 [ADR-011](../../docs/decisions/ADR-011-webgl-viewer.md)이다.

시뮬레이션 값은 시각화 목적이며 공학적 정확성을 주장하지 않는다. 가상 시설이다.

## 쓰는 법

```
npm install            # 처음 한 번
npm run dev            # 개발 서버 (http://localhost:5173)
npm test               # 자동 시험 (Vitest)
npm run build          # dist/ 만들기 + 용량 기준 점검
```

- 기본은 **녹화 재생**이다(서버 없음). 처음 화면은 건물 외관이고, 건물을 누르거나 Enter를 누르면 홀로 들어간다(Esc로 돌아옴). 주소 매개변수: `?stage=hall&scenario=fan_fault&t=60&view=power`
- **시뮬레이션(미리 계산한 값)**: 서버실 안 왼쪽 메뉴의 "시뮬레이션"(또는 `?mode=lib`). Warp 열 시뮬레이션과 보정 모델로 미리 계산한 상태와 시나리오 12개(이상 상황 4, 급기 온도 5, 부하 3)를 서버 없이 본다. 정의는 `sim/library.json`, 만드는 법은 `scripts/make_sim_library.py`.
- **간이 계산**: 왼쪽 메뉴의 "간이 계산"(또는 `?mode=sim`). 이 브라우저가 간단한 모델(L0)로 바로 계산하고 슬라이더로 조작한다. 시작값은 정상 녹화와 같다(`public/data/sim_init.json`). 미리 계산한 값과 모델이 다르다. 이 브라우저가 간이 모델(L0)로 계산하고 CRAC 팬 속도와 랙 전력을 슬라이더로 바꿀 수 있다([docs/21](../../docs/21_web_simulation_spec.md)). 배포한 페이지에서도 동작한다.
- **서버 데이터와 상세 시뮬레이션**: 서버(`server/`)에 연결하면 시뮬레이션 메뉴의 미리 계산한 값을 서버에서 받고(받지 못하면 사이트의 파일), 팬, 랙 전력, 급기 온도를 직접 바꿔 서버가 계산한다. 서버는 같은 포트에서 WebSocket(`/ws`)과 HTTP 데이터 API(`/api/...`)를 준다. 실행은 [server/README.md](../../server/README.md).
- **로컬 서버**: 위의 "로컬 서버" 단추(또는 `?server=ws://127.0.0.1:8765/ws`). 이 컴퓨터의 파이썬 계산 서버(`sim/sensors`, l0, l1, l2)가 실시간으로 계산하고 슬라이더 조작이 서버로 전달된다([docs/21](../../docs/21_web_simulation_spec.md) 4장). 서버 실행 방법은 단추를 누르면 나오는 안내에 있다.
- **라이브**: 게이트웨이를 띄우고 `?live=ws://127.0.0.1:8080/ws`로 연다. 이 컴퓨터의 `ws://`와 모든 `wss://`만 받는다.
  ```
  cd ../../gateway
  node src/index.js --manifest ../sim/out/sensor_manifest.json --replay ../sim/out/recordings/fan_fault_l2.jsonl --time-scale 5 --loop
  ```

## 공개 주소 (GitHub Pages)

https://jangdave.github.io/DC-Twin/ — `web/viewer`가 main에 병합되면 자동으로 다시 배포한다(`.github/workflows/web-viewer-pages.yml`). 녹화 재생만 된다. 라이브 모드는 이 컴퓨터의 게이트웨이(`ws://127.0.0.1`)로만 붙는다.

## 정적 자료 다시 만들기

`public/data/`는 만들어서 저장소에 올려 둔 파일이다. 원본(`sim/out`, `experiments/openfoam_baseline/layout.json`)이 바뀌면 다시 만든다.

```
npm run data
```

원본의 센서 생성기 녹화(`sim/out/recordings/*_l2.jsonl`)는 저장소에 없다(`sim/sensors`에서 `--solver l2`로 만든다, [docs/11](../../docs/11_data_spec.md)).

## 장비 모양(glb) 다시 만들기

`public/models/rack.glb`, `crac.glb`는 직접 제작한 `blender/rack.blend`, `crac.blend`에서 내보낸 것이다(텍스처 없음, 재질 색은 스크립트의 표). 모델을 고치면 다시 만든다. 주소 `?models=0`이나 화면의 "장비 모양" 단추로 단순 상자로 볼 수 있다.

```
blender -b blender/rack.blend --python blender/scripts/export_glb.py -- --out web/viewer/public/models
blender -b blender/crac.blend --python blender/scripts/export_glb.py -- --out web/viewer/public/models
```

## 서버실 껍데기(hall_shell.glb) 다시 만들기

`public/models/hall_shell.glb`(약 100 KB, 삼각형 1,252개)는 장면 USD의 `/DC/Hall01/Shell`(바닥, 벽 4개, 천장, 걸레받이, 바닥 표시, 조명)을 웹 좌표(m, Y 위)로 바꿔 내보낸 것이다. 장면에서 읽으므로 `hall01.config.json`을 고쳐 장면을 다시 만든 뒤 아래를 실행한다. 텍스처 이미지는 넣지 않고(원본이 저장소에 없다) 타일 무늬는 웹이 코드로 그린다. 처음 서버실에 들어갈 때 받으며, 받지 못하면 옛 어두운 바닥으로 계속 쓴다. 카메라가 벽 밖이면 그 벽을, 천장 위면 천장을 숨긴다.

```
cd scripts/usd_tools
uv run --python 3.13 python export_shell_glb.py ../../usd/scenes/hall01.usda ../../web/viewer/public/models/hall_shell.glb
```

## 시뮬레이션 기준 자료 다시 만들기

파이썬 L0와 값을 비교하는 기준 자료(`test/fixtures/sim_l0.json`)는 `sim/out/sensor_manifest.json`이 있어야 만들 수 있다.

```
cd ../../sim/sensors
uv run --python 3.13 python ../../web/viewer/tools/make_sim_fixture.py
```

## 화면 확인 도구 (헤드리스 Edge 또는 Chrome)

먼저 `npm run build`를 한다.

```
node tools/screenshot.mjs    # 시나리오별 캡처(shots/, 저장소에 올리지 않음) + 콘솔 오류 점검
node tools/ui_check.mjs      # 선택, 키보드, 재생 조작, 좁은 화면, 동작 줄이기
node tools/live_check.mjs    # 게이트웨이와 붙여 라이브 모드 확인(포트 18080 사용)
node tools/server_check.mjs  # 파이썬 로컬 계산 서버와 붙여 조작, 거절, 재접속 확인(포트 18765, sim/out 매니페스트와 uv 필요)
```

Edge나 Chrome이 기본 경로에 없으면 `--browser <경로>`로 알려 준다.

## 폴더

| 경로 | 내용 |
|---|---|
| `src/colors.js` | 온도 색, 등급 색, 막대 길이(Unreal과 같은 규칙) |
| `src/sources.js` | 데이터 출처 어댑터(녹화, 시뮬레이션, 라이브/서버)를 같은 모양으로 감쌈 |
| `src/store.js`, `recording.js`, `live.js`, `messages.js`, `url.js` | 센서 값 저장소, 녹화 재생, 라이브 연결, 메시지 검사, 주소 규칙 |
| `src/sim/` | 직접 시뮬레이션: `core.js`(L0 모델, 알람, 시나리오), `engine.js`, `runner.js`, `panel.js`, 에너지·용량·이상 대비(`insight.js`, `insight_panel.js`) |
| `src/apply.js` | 메시지를 저장소에 반영(라이브와 시뮬레이션 공용) |
| `src/flow.js` | 화면 단계(외관/홀), 화면 이동 명령과 명령 큐, 건물 요약 |
| `src/workspace.js` | 작업 공간 상태: 눌린 메뉴, CCTV, 보기 값의 규칙과 화면 값 계산(순수 함수, 설계는 [docs/27](../../docs/27_web_ui_redesign_plan.md) 15장) |
| `src/cctv.js`, `cctv_ui.js`, `hall_shell.js`, `views.js` | 가상 CCTV 카메라 계산과 화면, 서버실 껍데기, 보는 값 정의 |
| `src/scene.js`, `ui.js`, `main.js` | 3D 장면, 화면 조각, 조립 |
| `tools/` | 자료 변환(`build_data`), 용량 점검, 화면 확인(`check:ui`), 글자 대비(`check:contrast`), 데이터 정합성(`check:data`) |
| `test/` | 자동 시험 |
| `public/data/` | 장면, 센서 목록, 시나리오 녹화(정적 자료) |
