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
docker run --rm -p 127.0.0.1:8765:8765 dct-sim-server
```
또는 `docker compose -f server/docker-compose.yml up --build`.
**시험하지 못했다.** 이 구성을 만든 컴퓨터에 Docker가 없다. Dockerfile 문법과 파일 경로는 코드로만 확인했다(`test_server_files.py`). 처음 빌드해 보고 문제가 있으면 고쳐야 한다. GPU 모델(L1, L2)은 이 이미지에 없다.

## 데이터 API (읽기 전용)
| 경로 | 내용 |
|---|---|
| `GET /healthz` | `{"ok": true, "solver": "l2"}` |
| `GET /api/meta` | 모델, 받는 조작 종류, 급기 온도 범위(14~27), 라이브러리 항목 수 |
| `GET /api/library` | `{ version, groups, index }`(목록. 압축 가능) |
| `GET /api/library/<id>` | 그 항목의 녹화. 급기 18도와 부하 100%는 정상 가동 녹화를 돌려줌 |

## 안전
이 서버는 **조작을 받는다.** 그래서 기본은 막아 두었다.
- 기본은 `127.0.0.1`에만 열린다. 다른 주소는 `--allow-remote` 없이는 거절한다(Docker는 컨테이너 안에서 `0.0.0.0`으로 열고, 밖으로는 `-p 127.0.0.1:...`로 이 컴퓨터에만 연다).
- 웹 페이지 출처(Origin)를 확인한다. 기본 허용: `127.0.0.1`, `localhost`, `https://jangdave.github.io`. 더하려면 `--origin https://...`.
- 조작은 종류, 장비 이름, 값 범위만 받는다. 메시지 크기, 접속 수(8), 조작 횟수(초당 20), 데이터 API 요청 수(초당 60)를 제한한다.
- 데이터 API는 목록에 있는 id의 파일만 연다(경로를 받지 않는다).
- 한계: 출처 확인은 **브라우저에만** 효과가 있다. 브라우저가 아닌 도구는 Origin 없이 접속하며 조작을 보낼 수 있다. 인증이 없다.
- **서버 상태는 접속한 화면이 모두 함께 쓴다.** 한 화면이 급기 온도를 바꾸면 다른 화면에도 반영된다(시나리오를 다시 시작하면 처음 값으로 돌아간다).

### 밖에 열기(공개 사이트에서 쓰려면)
GitHub Pages 같은 `https://` 페이지는 암호화되지 않은 서버(`ws://`, `http://`)에 `127.0.0.1` 밖으로는 접속하지 못하고, 웹 화면도 `wss://`만 받는다(`src/url.js`). 밖에 열려면 **TLS를 끝내 주는 앞단**(Caddy, nginx, Cloudflare Tunnel 등)을 두고 서버는 그 뒤에서 `127.0.0.1`로 연다. 인증과 요청 제한도 앞단에서 건다. 이 저장소는 그 구성을 제공하지 않는다. 열기 전에 [ADR-004](../docs/decisions/ADR-004-streaming-hosting.md)의 호스팅 결정을 먼저 본다.

## 파일
| 파일 | 내용 |
|---|---|
| `data/sensor_manifest.json` | 센서 매니페스트 사본(`scripts/usd_tools/build_manifest.py`가 USD에서 만든 것). 원본(`sim/out/`)은 gitignore라서 서버가 쓰도록 사본을 둔다. 같은지 시험이 확인한다 |
| `Dockerfile`, `Dockerfile.dockerignore`, `docker-compose.yml` | CPU 이미지(L0 + 데이터 API) |
| `run_local.ps1` | A 방법을 한 줄로 |

## 모델과 값의 한계
시각화 목적이며 공학적 정확성을 주장하지 않는다. 급기 온도에 따른 냉각 전력(1도당 3%)은 실측이 아닌 가정이다. 자세한 한계는 [docs/27 16.6](../docs/27_web_ui_redesign_plan.md).
