"""Kit 안에서 V1 물리 점검(`verify_physics.py`)을 돌린다 (docs/32 4장).

Kit이 장면 USD를 열고(stage에 올린 prim 수를 기록), Kit의 Warp로 같은 점검을 돌린다. 결과는 out/verify/v1_kit/.
환경 변수: DCT_V1_ARGS(verify_physics 인자, 예: "--dx 0.2 0.1 --cases normal")
실행: kit\\kit.exe apps\\dctwin.base_editor.kit --no-window --/app/file/ignoreUnsavedOnExit=true --exec "<경로>/kit_verify_physics.py"
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

ROOT = Path("D:/Test")
HERE = ROOT / "experiments/omniverse_probe"
OUT = HERE / "out/verify/v1_kit"
sys.path[:0] = [os.environ.get("DCT_PYDEPS", "D:/omniverse-kit/pydeps"), str(HERE)]
res: dict = {}


async def run():
    try:
        t0 = time.time()
        ctx = omni.usd.get_context()
        await ctx.open_stage_async(str(ROOT / "usd/scenes/hall01.usda"))
        res["kit_stage_prims"] = sum(1 for _ in ctx.get_stage().Traverse())
        res["kit_open_s"] = round(time.time() - t0, 2)
        import verify_physics as vp

        args = shlex.split(os.environ.get("DCT_V1_ARGS", "")) + ["--out", str(OUT)]
        loop = asyncio.get_running_loop()
        out = await loop.run_in_executor(None, lambda: vp.main(args, env="Kit 110.4.0 안"))  # 계산은 다른 스레드(Kit 갱신 루프를 막지 않게)
        res["ok"] = True
        res["cases"] = {c: {dx: {k: r[k] for k in ("steady_at_s", "heat_balance_pct", "inlet_mean_C", "inlet_max_C", "wall_s")} for dx, r in v.items()} for c, v in out["cases"].items()}
    except Exception as e:  # noqa: BLE001
        res.update({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-2000:]})
    finally:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "kit_run.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        print("[kit_verify_physics]", json.dumps(res, ensure_ascii=False)[:2000], flush=True)
        omni.kit.app.get_app().post_quit()


asyncio.ensure_future(run())
