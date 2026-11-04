"""Kit 안에서 랙 60기 홀 열 시뮬레이션(hall60_sim.py)을 돌려 센서 값을 뽑는다.

하는 일
1. Kit이 USD 장면(`usd/scenes/hall01.usda`)을 직접 연다(Kit의 stage에 올라간 prim 수를 기록).
2. Kit에 들어 있는 Warp(1.17.0)와 numpy로 hall60_sim.main()을 그대로 실행한다. 솔버 코드는 독립 실행과 같은 파일이다.
3. 결과(센서 CSV, 요약, 온도 프레임, 단면 그림)를 `out/kit/hall60_kit/`에 저장한다.

Kit에는 scipy가 없다(numpy, PIL, Warp는 있음). 저장소 밖 `D:\\omniverse-kit\\pydeps`에 Kit 파이썬(3.12)용으로 받아 둔다:
    uv pip install --target D:/omniverse-kit/pydeps --python-version 3.12 --python-platform windows --no-deps scipy

실행(README 참고): kit\\kit.exe apps\\dctwin.base_editor.kit --/app/file/ignoreUnsavedOnExit=true --exec "<경로>/kit_hall60.py"
환경 변수: DCT_ARGS(hall60_sim 인자, 기본 "--duration 300 --fail CRAC_02,CRAC_06 --fail-time 60"), DCT_KIT_OUT, DCT_PYDEPS

주의: 이 스크립트가 Kit에서 하는 일은 USD 열기와 Warp 실행 환경 제공이다. 열 모델은 Kit 기능이 아니라 우리 솔버이며, CFD가 아니다(시각화 목적).
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
import time
import traceback
from pathlib import Path

import omni.kit.app
import omni.usd

PROBE = Path("D:/Test/experiments/omniverse_probe")
SCENE = Path("D:/Test/usd/scenes/hall01.usda")
OUT = Path(os.environ.get("DCT_KIT_OUT", PROBE / "out" / "kit" / "hall60_kit"))
PYDEPS = os.environ.get("DCT_PYDEPS", "D:/omniverse-kit/pydeps")
ARGS = shlex.split(os.environ.get("DCT_ARGS", "--duration 300 --fail CRAC_02,CRAC_06 --fail-time 60"))

res: dict = {"args": ARGS}


async def run() -> None:
    try:
        sys.path.insert(0, PYDEPS)
        sys.path.insert(0, str(PROBE))
        # 1) Kit이 장면을 연다
        ctx = omni.usd.get_context()
        t0 = time.time()
        ok, err = await ctx.open_stage_async(str(SCENE))
        stage = ctx.get_stage()
        prims = sum(1 for _ in stage.Traverse()) if stage else 0
        res["open_usd"] = {"ok": bool(ok), "error": str(err) if err else None, "prims": prims, "seconds": round(time.time() - t0, 2)}
        print("[kit_hall60] 장면 열기:", res["open_usd"], flush=True)

        # 2) Kit의 Warp와 numpy로 같은 솔버를 실행한다
        import numpy
        import scipy
        import warp as wp

        res["versions"] = {"warp": wp.__version__, "numpy": numpy.__version__, "scipy": scipy.__version__, "python": sys.version.split()[0]}
        import hall60_sim as h

        OUT.mkdir(parents=True, exist_ok=True)
        h.OUT = OUT
        sys.argv = ["hall60_sim.py", "--scene", str(SCENE), *ARGS]
        t1 = time.time()
        h.main()
        res["solver_seconds"] = round(time.time() - t1, 2)
        res["ok"] = True
    except Exception as e:  # noqa: BLE001
        res["ok"] = False
        res["error"] = f"{type(e).__name__}: {e}"
        res["trace"] = traceback.format_exc()[-1500:]
        print("[kit_hall60] 실패:", res["error"], flush=True)
    finally:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "kit_run.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[kit_hall60] 결과 저장, Kit 종료 요청", flush=True)
        omni.kit.app.get_app().post_quit()


asyncio.ensure_future(run())
