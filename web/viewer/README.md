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
- **라이브**: 게이트웨이를 띄우고 `?live=ws://127.0.0.1:8080/ws`로 연다. 이 컴퓨터의 `ws://`와 모든 `wss://`만 받는다.
  ```
  cd ../../gateway
  node src/index.js --manifest ../sim/out/sensor_manifest.json --replay ../sim/out/recordings/fan_fault_l2.jsonl --time-scale 5 --loop
  ```

## 공개 주소 (GitHub Pages)

https://jangdave.github.io/Portfolio_DT/ — `web/viewer`가 main에 병합되면 자동으로 다시 배포한다(`.github/workflows/web-viewer-pages.yml`). 녹화 재생만 된다. 라이브 모드는 이 컴퓨터의 게이트웨이(`ws://127.0.0.1`)로만 붙는다.

## 정적 자료 다시 만들기

`public/data/`는 만들어서 저장소에 올려 둔 파일이다. 원본(`sim/out`, `experiments/openfoam_baseline/layout.json`)이 바뀌면 다시 만든다.

```
npm run data
```

원본의 센서 생성기 녹화(`sim/out/recordings/*_l2.jsonl`)는 저장소에 없다(`sim/sensors`에서 `--solver l2`로 만든다, [docs/11](../../docs/11_data_spec.md)).

## 화면 확인 도구 (헤드리스 Edge 또는 Chrome)

먼저 `npm run build`를 한다.

```
node tools/screenshot.mjs    # 시나리오별 캡처(shots/, 저장소에 올리지 않음) + 콘솔 오류 점검
node tools/ui_check.mjs      # 선택, 키보드, 재생 조작, 좁은 화면, 동작 줄이기
node tools/live_check.mjs    # 게이트웨이와 붙여 라이브 모드 확인(포트 18080 사용)
```

Edge나 Chrome이 기본 경로에 없으면 `--browser <경로>`로 알려 준다.

## 폴더

| 경로 | 내용 |
|---|---|
| `src/colors.js` | 온도 색, 등급 색, 막대 길이(Unreal과 같은 규칙) |
| `src/store.js`, `recording.js`, `live.js`, `messages.js`, `url.js` | 센서 값 저장소, 녹화 재생, 라이브 연결, 메시지 검사, 주소 규칙 |
| `src/flow.js` | 화면 단계(외관/홀), 화면 이동 명령과 명령 큐, 건물 요약 |
| `src/scene.js`, `ui.js`, `main.js` | 3D 장면, 화면 조각, 조립 |
| `tools/` | 자료 변환, 용량 점검, 화면 확인 |
| `test/` | 자동 시험 |
| `public/data/` | 장면, 센서 목록, 시나리오 녹화(정적 자료) |
