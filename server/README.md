# DC-Twin 시뮬레이션 서버

- 상태: 초안 (2026-11-04)
- 목적: 모델 계산처럼 무겁거나 화면 프레임을 떨어뜨릴 수 있는 일을 서버가 맡고, 웹 보기 화면은 서버에서 필요한 값을 받아 쓰게 한다.
- 관련: [docs/21 웹 시뮬레이션](../docs/21_web_simulation_spec.md), [docs/27 16.6~16.7](../docs/27_web_ui_redesign_plan.md), [ADR-004 호스팅](../docs/decisions/ADR-004-streaming-hosting.md)

## 서버가 하는 일
| 일 | 어떻게 | 어디서 |
|---|---|---|
| 상세 시뮬레이션 계산 | 팬, 랙 전력, 급기 온도 조작을 받아 모델(L0, L1 Warp, L2 보정)로 계산하고 센서 값을 보냄(WebSocket `/ws`) | `sim/sensors/dct_sensors/serve.py` |
| 미리 계산한 값 제공 | 이상 상황, 급기 온도, 부하 12개의 목록과 녹화를 JSON으로 줌(HTTP `/api/...`) | `sim/sensors/dct_sensors/api.py` |

웹 화면은 서버가 없으면 지금처럼 브라우저에서 동작한다(사이트에 포함된 미리 계산한 값과 간이 계산). 서버에 연결하면:
- 시뮬레이션 메뉴의 값을 서버에서 받는다(받지 못하면 사이트의 파일로 돌아간다. 화면에 출처가 보인다).
- 서버 조작(팬, 전력, **급기 온도**)이 열린다. 열 계산은 서버가 한다.

## 실행 방법 세 가지
저장소 루트에서 시작한다. 웹 화면은 `?server=ws://127.0.0.1:8765/ws`를 붙이거나 화면의 "로컬 서버" 단추에 주소를 넣는다.

### A. 이 컴퓨터, GPU로 L2(Warp 열 계산 + 보정 모델) — 가장 자세함
Warp와 scikit-learn이 있는 환경(`experiments/omniverse_probe`)에서 실행한다. `server/run_local.ps1`이 같은 일을 한다.
```powershell
cd experiments\omniverse_probe
$env:PYTHONPATH = "..\..\sim\sensors"
uv run --python 3.13 --with websockets python -m dct_sensors.serve --manifest ..\..\server\data\sensor_manifest.json --solver l2 --speed 5
```
- `--solver l0`은 CPU로 되는 간단한 모델, `l1`은 Warp, `l2`는 Warp + 보정 모델(신뢰 막대가 나옴).
- 시작할 때 열 상태를 예열하느라 수십 초 걸린다. 기본은 `127.0.0.1`에만 열린다.
- 이 방법은 **직접 실행해서 확인했다**(2026-11-04, RTX 5090): 데이터 API, 급기 온도 조작(냉각 전력 32.00 → 26.24 kW, 가정한 0.82배와 같음), 범위 밖 값 거절, 경로 탈출 404, 허용하지 않은 출처의 CORS 머리글 없음, 웹 화면과의 연결.

### B. 이 컴퓨터, CPU만 (L0)
```powershell
cd sim\sensors
uv run --python 3.13 --extra serve python -m dct_sensors.serve --manifest ..\..\server\data\sensor_manifest.json --solver l0 --data-dir ..\..\web\viewer\public\data
```

### C. Docker (CPU, L0 + 미리 계산한 값)
```
docker build -f server/Dockerfile -t dct-sim-server .
docker run --rm -p 127.0.0.1:8765:8765 -e DCT_TOKEN=<16자 이상 토큰> dct-sim-server
```
또는 `DCT_TOKEN=<토큰>`을 환경 변수나 `server/.env`(저장소에 올리지 않음)에 두고 `docker compose -f server/docker-compose.yml up --build`.
컨테이너 안에서는 `0.0.0.0`으로 열어야 해서 **토큰 없이는 시작하지 않는다**(종료 코드 2). 토큰은 이미지에 넣지 않고 실행할 때 준다. GPU 모델(L1, L2)은 이 이미지에 없다.
**확인했다**(2026-11-04): WSL의 Docker Engine 29.1.3에서 빌드(280 MB), 실행, 헬스체크(healthy), 비루트(uid 10001), 읽기 전용에 권한 제거와 메모리 제한을 건 채로 Windows에서 접속, 토큰 없음과 약한 토큰의 시작 거부, 컨테이너 대상 WebSocket 인증. 첫 실행에서 컨테이너 안에서는 저장소 루트를 찾지 못해 서버가 시작하지 못하는 결함을 찾아 고쳤다. Docker Desktop은 쓰지 않았다(라이선스 약관이 있어 피함). Windows에서 같은 방법을 쓰려면 WSL 안에 Docker Engine(`apt install docker.io`)을 설치한다.

## Omniverse Kit 안에서 띄우기와 시뮬레이션 작업 (2026-11-10)

```
.\server\run_local.ps1 -Kit            # Kit 앱이 장면 USD를 열고 같은 프로세스에서 서버를 돌린다(창 없음, 시작 약 15초)
```

- `server/kit_server.py`가 Kit 안에서 `dct_sensors.serve`를 별도 스레드로 돌린다. 실시간 센서 값(기본 L2)과 **시뮬레이션 작업**(`--jobs`)을 함께 준다.
- 시뮬레이션 작업은 WebSocket 메시지로 주고받는다: `{"type":"job","action":"submit","conditions":{...}}` → 진행 알림 `{"type":"job","job":{state, stage, progress, etaS, ...}}`(모든 접속에 보냄) → `{"type":"job","action":"result","id":"..."}` → `{"type":"job_result","rec":{...}}`(웹 녹화 형식). `status`, `cancel`, `list`도 있다. 조건과 단계는 `docs/31` 3장, 4.1장.
- `precise: true`(기본)면 팬 상태마다 WSL의 OpenFOAM으로 공기 흐름을 풀고(약 6~7분씩, 같은 조건이면 저장해 둔 흐름을 다시 씀) 우리 온도 계산으로 시간 변화를 낸다. `false`면 보정 모델(L2)로 바로 낸다(1분 이내).
- Kit에 없는 파이썬 패키지(scipy, scikit-learn, joblib, threadpoolctl, cloudpickle, narwhals)는 저장소 밖 `D:/omniverse-kit/pydeps`에 Kit 파이썬(3.12)용으로 받는다: `uv pip install --target D:/omniverse-kit/pydeps --python-version 3.12 --python-platform windows --no-deps <이름>`.
- Kit에는 websockets 12.0(옛 API)이 들어 있어 그것을 쓴다. 서버 코드는 옛 API와 새 API(13 이상)를 모두 받는다.
- 끝내기: Ctrl+C(스크립트가 `sim/out/kit_server.stop`을 만들어 알리고 15초 뒤에도 안 끝나면 Kit을 끝낸다).
- 확인(2026-11-10): Kit 안 서버에 접속(16초), 실시간 sample, `/api/meta`, 정확한 작업(저장한 흐름 재사용), 빠른 작업(L2) 결과 받기.

## 데이터 API (읽기 전용)
| 경로 | 내용 |
|---|---|
| `GET /healthz` | `{"ok": true, "solver": "l2"}` |
| `GET /api/meta` | 모델, 받는 조작 종류, 급기 온도 범위(14~27), 라이브러리 항목 수 |
| `GET /api/library` | `{ version, groups, index }`(목록. 압축 가능) |
| `GET /api/library/<id>` | 그 항목의 녹화. 급기 18도와 부하 100%는 정상 가동 녹화를 돌려줌 |

## 안전
이 서버는 **조작을 받는다.** 그래서 기본은 막아 두었다.
- 기본은 `127.0.0.1`에만 열린다. 다른 주소는 `--allow-remote` 없이는 거절하고, **열려면 접근 토큰이 필요하다**(없으면 시작하지 않는다. 토큰 없이 열려면 `--no-auth`를 명시해야 한다). Docker는 컨테이너 안에서 `0.0.0.0`으로 열고(토큰 필수), 밖으로는 `-p 127.0.0.1:...`로 이 컴퓨터에만 연다.
- **접근 토큰**(`--token <16자 이상>`, `--token auto`는 만들어서 한 번 보여 줌, 환경 변수 `DCT_TOKEN`): 켜면 WebSocket은 연결한 뒤 **첫 메시지로 토큰을 보내야** 한다(`{"type":"auth","token":"..."}`). 토큰을 주소에 넣지 않으므로 서버 로그나 브라우저 기록에 남지 않는다. 5초 안에 못 보내거나 틀리면 1008로 닫고, 인증 전에는 값을 한 줄도 보내지 않는다. 같은 주소에서 틀린 시도가 분당 5번을 넘으면 1013으로 잠시 막는다(맞는 토큰이어도). 토큰은 공백 없이 16자 이상이며 상수 시간으로 비교한다. 웹 화면은 서버 연결 창의 "접근 토큰"에 넣는다(메모리에만 두고 저장하지 않으며, 인증이 거절되면 다시 시도하지 않고 이유를 보인다).
- **데이터 API는 기본 공개**다. 내용이 공개 사이트에 이미 있는 값이고, 토큰으로 지킬 것은 조작과 계산이다. `--private-data`를 주면 `Authorization: Bearer`를 요구하지만, 브라우저는 그 머리글 때문에 사전 확인(OPTIONS)을 먼저 보내는데 이 서버(websockets)는 GET만 받아 응답하지 못한다. **그래서 비공개 모드는 curl 같은 도구용이고, 웹 화면은 그 모드에서 데이터를 못 받아 사이트의 파일을 쓴다.**
- 웹 페이지 출처(Origin)를 확인한다. 기본 허용: `127.0.0.1`, `localhost`, `https://jangdave.github.io`. 더하려면 `--origin https://...`.
- 조작은 종류, 장비 이름, 값 범위만 받는다. 메시지 크기, 접속 수(8), 조작 횟수(초당 20), 데이터 API 요청 수(초당 60)를 제한한다.
- 데이터 API는 목록에 있는 id의 파일만 연다(경로를 받지 않는다).
- 한계: 출처(Origin) 확인은 **브라우저에만** 효과가 있다. 인증(토큰)을 켜지 않은 서버(`127.0.0.1` 전용 기본값)에서는 브라우저가 아닌 도구가 조작을 보낼 수 있다. 토큰은 **하나를 모두가 나눠 쓰는 비밀**이라 사용자별 권한이나 폐기, 만료가 없다(바꾸려면 서버를 다시 시작). 인증하지 않은 접속은 5초 동안 자리를 차지할 수 있다(최대 16개). 같은 주소 기준 잠금은 앞단(프록시) 뒤에서는 모든 사용자가 한 주소로 보여 효과가 약하다. **토큰은 암호화(TLS) 없이 보내면 도청된다**(`wss://`를 쓰는 앞단이 필요하다).
- **서버 상태는 접속한 화면이 모두 함께 쓴다.** 한 화면이 급기 온도를 바꾸면 다른 화면에도 반영된다(시나리오를 다시 시작하면 처음 값으로 돌아간다).

### 밖에 열기(공개 사이트에서 쓰려면)
GitHub Pages 같은 `https://` 페이지는 암호화되지 않은 서버(`ws://`, `http://`)에 `127.0.0.1` 밖으로는 접속하지 못하고, 웹 화면도 `wss://`만 받는다(`src/url.js`). 밖에 열려면 **TLS를 끝내 주는 앞단**(Caddy, nginx, Cloudflare Tunnel 등)을 두고 서버는 그 뒤에서 `127.0.0.1`로 연다(토큰은 TLS 안에서만 안전하다). 이 저장소는 그 구성을 제공하지 않으며 **직접 시험하지 않았다.** 열기 전에 [ADR-004](../docs/decisions/ADR-004-streaming-hosting.md)의 호스팅 결정을 먼저 본다.

## 외부 솔버 결과 (상용 도구 포함)

상용 CFD 도구(예: Cadence Reality DC)나 다른 솔버의 계산 결과를 이 서버를 거쳐 **이 컴퓨터의 화면에서만** 볼 수 있게 하는 파이프라인이다. **구성만 해 둔 것**이며, 실제 외부 도구의 파일로는 시험하지 못했다(합성 파일로만 확인).

### 지켜야 하는 규칙 ([docs/04](../docs/04_clean_room_policy.md), [CLAUDE.md](../CLAUDE.md))
- 상용 도구로 계산한 결과나 화면을 **저장소, PR, 영상, 문서에 올리지 않는다.** 회사 프로젝트의 파일(`.room` 등)과 데이터를 쓰지 않는다. 우리 가상 홀의 형상으로 계산한 결과만 다룬다.
- 상용 도구의 결과를 개인 포트폴리오 용도로 계산해도 되는지는 **라이선스와 회사 규정에 달려 있다.** 이 도구는 그것을 판단하지 않는다. 사용자가 확인한 뒤에 쓴다.
- 그래서 파이프라인은 결과가 새어 나가지 않게 만들었다.
  - 출력은 git이 무시하는 위치에만 쓴다(기본 `sim/out/local_only/external_pack/`). 저장소에 올라갈 수 있는 위치는 거절한다(`ensure_ignored`).
  - `.gitignore`가 `*.vtk`, `*.vtu`, `*.vti`, `*.room`을 막는다.
  - CI가 저장소에 그런 파일이 없는지, 공개 사이트의 목록과 녹화에 외부 항목이 없는지 시험한다(`web/viewer/test/external_guard.test.js`).
  - 화면은 **서버가 줄 때만** 외부 항목을 본다(서버에 연결해야 한다). 항목을 고르면 모드 표시가 "외부 솔버 결과 (도구 이름) · 이 컴퓨터의 서버만 줌"으로 바뀌어 우리 모델의 값과 구분된다.

### 흐름
```
외부 도구의 .vtk ──(inspect로 구조 확인)──▶ mapping.json(단위, 축, 원점, 값 이름, 조건)
      │
      ▼  python -m dct_sensors.external build
앵커 위치(server/data/anchors.json)에서 온도를 읽음 ──▶ 녹화 JSON(정상 상태 300초) ──▶ sim/out/local_only/external_pack/
                                                                                              │
                                  서버: --extra-data-dir sim/out/local_only/external_pack ◀──┘
                                                │
                                웹: 시뮬레이션 메뉴 "외부 솔버 결과 (로컬 전용)" 그룹
```

### 쓰는 방법
```powershell
cd sim\sensors
# 1) 파일의 구조를 본다(좌표 범위, 값 이름과 범위). 단위는 파일에 없어서 mapping의 unit으로 알려 준다
uv run --python 3.13 python -m dct_sensors.external inspect <결과.vtk>
# 2) mapping.json을 쓴다(항목 설명은 sim/sensors/dct_sensors/external/mapping.py 머리말)
# 3) 변환한다
uv run --python 3.13 python -m dct_sensors.external build --vtk <결과.vtk> --mapping mapping.json --id ext_case1 --title "사례 1" --note "설명"
# 4) 서버를 묶음과 함께 띄운다
.\server\run_local.ps1 -Solver l0   # 묶음을 쓰려면 --extra-data-dir 인자를 직접 준다(아래)
uv run --python 3.13 --extra serve python -m dct_sensors.serve --manifest ..\..\server\data\sensor_manifest.json --solver l0 --data-dir ..\..\web\viewer\public\data --extra-data-dir ..\out\local_only\external_pack
```
파일 없이 전체 흐름만 확인하려면 `python -m dct_sensors.external demo`(합성 시험 데이터로 `ext_demo`를 만든다. **실제 계산 결과가 아니다**).

### 무엇을 읽고 무엇을 채우나 (정직하게)
- **읽는 것:** 랙 입구·출구 온도와 CRAC 회수 온도를, 센서 앵커(가상 홀 USD에서 뽑은 위치) 가장 가까운 점의 값으로. 앵커가 `max_distance_cm` 안에 값이 없으면 **실패하고** 좌표 범위와 확인할 항목(unit, axes, origin_cm)을 알려 준다.
- **채우는 것:** 전력, 팬 속도, 급기 온도는 mapping의 `case`에 있으면 그 값, 없으면 정상 가동 녹화의 평균. 어느 센서가 CFD 값이고 어느 것이 채운 값인지 녹화의 `meta.filled`에 남는다.
- 외부 계산은 **정상 상태 한 장면**이라 300초 동안 같은 값이다(시간 변화 없음). 집계(IT, 냉각, 설비 전력, PUE)는 우리 식으로 합성한다.
- 알람은 서버, 생성기와 같은 판정 규칙(연속 2회, 히스테리시스)으로 계산한다.
- 지원하는 입력: 레거시 `.vtk`(ASCII, BINARY)의 STRUCTURED_POINTS, RECTILINEAR_GRID, STRUCTURED_GRID, UNSTRUCTURED_GRID(점 값 또는 셀 값). 지원하지 않는 것: XML(`.vtu`, `.vti`), POLYDATA, 압축, 비정렬 값의 보간(가장 가까운 점 값을 쓴다).
- **한계:** 실제 외부 도구의 `.vtk`로 시험하지 못했다. 시험은 이 저장소가 만든 합성 파일과 OpenFOAM `foamToVTK` 모양(UNSTRUCTURED_GRID, CELL_DATA)을 흉내 낸 파일로 한다. 실제 파일이 이 모양과 다르면 `inspect` 단계에서 이유와 함께 거절한다. 그때 읽기 코드를 고쳐야 한다.

## 파일
| 파일 | 내용 |
|---|---|
| `data/sensor_manifest.json` | 센서 매니페스트 사본(`scripts/usd_tools/build_manifest.py`가 USD에서 만든 것). 원본(`sim/out/`)은 gitignore라서 서버가 쓰도록 사본을 둔다. 같은지 시험이 확인한다 |
| `data/anchors.json` | 센서 앵커 위치 사본(가상 홀 USD에서 `scripts/export_anchors.py`로 뽑음). 외부 결과 변환이 쓴다 |
| `Dockerfile`, `Dockerfile.dockerignore`, `docker-compose.yml` | CPU 이미지(L0 + 데이터 API) |
| `run_local.ps1` | A 방법을 한 줄로 |

## 모델과 값의 한계
시각화 목적이며 공학적 정확성을 주장하지 않는다. 급기 온도에 따른 냉각 전력(1도당 3%)은 실측이 아닌 가정이다. 자세한 한계는 [docs/27 16.6](../docs/27_web_ui_redesign_plan.md).
