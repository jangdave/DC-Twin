"""Omniverse Kit 안에서 로컬 서버를 돌린다 (docs/31 8장, 2026-11-10 사용자 결정: "옴니버스 kit 활용하는 로컬 서버로").

Kit이 장면 USD(`usd/scenes/hall01.usda`)를 열고, 같은 프로세스에서 센서 생성기(실시간, 기본 L2)와
시뮬레이션 작업(조건 → USD 층 → OpenFOAM 흐름 → 우리 온도 계산)을 웹에 WebSocket으로 내준다.
서버 코드는 `sim/sensors/dct_sensors/serve.py` 그대로이고, Kit의 갱신 루프를 막지 않도록 별도 스레드에서 돈다(E0 2.26에서 확인한 방식).

실행은 `server/run_local.ps1 -Kit`가 한다. 직접 실행할 때:
    set DCT_SERVER_ARGS=--manifest D:/Test/server/data/sensor_manifest.json --solver l2 --jobs
    kit\\kit.exe apps\\dctwin.base_editor.kit --no-window --/app/file/ignoreUnsavedOnExit=true --exec "D:/Test/server/kit_server.py"
Kit에 없는 파이썬 패키지(scipy, scikit-learn, joblib, threadpoolctl, cloudpickle, narwhals)는 저장소 밖 `D:/omniverse-kit/pydeps`에 둔다(`DCT_PYDEPS`).
끝내기: `sim/out/kit_server.stop` 파일을 만들거나 Kit 프로세스를 끝낸다(run_local.ps1은 Ctrl+C 때 끝낸다).
"""
from __future__ import annotations

import asyncio
import os
import shlex
import sys
import threading
import time
import traceback
from pathlib import Path

import omni.kit.app
import omni.usd

ROOT = Path(os.environ.get("DCT_REPO", "D:/Test"))
sys.path[:0] = [os.environ.get("DCT_PYDEPS", "D:/omniverse-kit/pydeps"), str(ROOT / "sim" / "sensors"), str(ROOT / "experiments" / "omniverse_probe")]
STOP = ROOT / "sim" / "out" / "kit_server.stop"
ARGS = shlex.split(os.environ.get("DCT_SERVER_ARGS", f"--manifest {ROOT / 'server' / 'data' / 'sensor_manifest.json'} --solver l2 --jobs").replace("\\", "/"))  # Windows 경로의 \를 shlex가 지우지 않게


def log(msg: str) -> None:
    print(f"[kit_server] {msg}", file=sys.stderr, flush=True)


async def run() -> None:
    state = {"code": None}
    try:
        t0 = time.time()
        ctx = omni.usd.get_context()
        await ctx.open_stage_async(str(ROOT / "usd" / "scenes" / "hall01.usda"))
        log(f"장면을 열었다: prim {sum(1 for _ in ctx.get_stage().Traverse())}개, {time.time() - t0:.2f}초")
        STOP.unlink(missing_ok=True)
        # 홀 정보는 Kit이 연 장면에서 메인 스레드가 한 번 읽어 둔다. 서버 스레드가 같은 파일을 다시 열면 Kit의 장면과 부딪혔다(2026-11-10).
        import hall60_sim as hs

        scene = (ROOT / "usd" / "scenes" / "hall01.usda").resolve()
        hs.HALL_CACHE[str(scene)] = hs.read_hall_from_stage(ctx.get_stage())
        h = hs.HALL_CACHE[str(scene)]
        log(f"홀 정보를 Kit 장면에서 읽었다: 랙 {len(h['racks'])}, CRAC {len(h['cracs'])}, 센서 앵커 {len(h['anchors'])}")
        # Kit에는 websockets 12.0(옛 API)이 들어 있고, 경로를 바꾸거나 모듈을 갈아 끼워도 일부가 계속 Kit 것으로 올라왔다(2026-11-10).
        # 그래서 서버 코드(serve.py)가 옛 API와 새 API를 모두 받게 하고 Kit의 것을 그대로 쓴다.
        import websockets

        log(f"websockets {websockets.__version__} ({Path(websockets.__file__).parent})")
        from dct_sensors import serve

        def server():
            try:
                state["code"] = serve.main(ARGS)
            except SystemExit as e:  # 인자 오류 등
                state["code"] = e.code
            except Exception:  # noqa: BLE001
                log("서버가 오류로 멈췄다:\n" + traceback.format_exc()[-2000:])
                state["code"] = 1

        th = threading.Thread(target=server, name="dct-server", daemon=True)
        th.start()
        log(f"서버 시작: {' '.join(ARGS)}")
        while th.is_alive():
            if STOP.exists():
                log("끝내기 파일을 찾았다. 서버를 멈춘다")
                break
            await asyncio.sleep(0.5)  # Kit 갱신 루프를 막지 않고 기다린다
    except Exception:  # noqa: BLE001
        log("시작 실패:\n" + traceback.format_exc()[-2000:])
    finally:
        STOP.unlink(missing_ok=True)
        log(f"끝 (서버 종료 코드 {state['code']})")
        omni.kit.app.get_app().post_quit()


asyncio.ensure_future(run())
