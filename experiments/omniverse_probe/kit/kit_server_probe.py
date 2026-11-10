"""2a 확인: Kit 앱 안에서 로컬 서버를 돌릴 수 있는가 (docs/31 6장).

확인하는 것
1. 창 없이 시작되는가(--no-window로 띄운 쪽에서 본다)
2. Kit 안에서 장면 USD를 연 채로 WebSocket 서버(별도 스레드의 asyncio)가 요청에 답하는가
3. 서버가 도는 동안 같은 프로세스에서 Warp 계산을 돌릴 수 있는가
4. 끝나면 프로세스가 남지 않고 종료되는가

환경 변수: DCT_PORT(기본 18790), DCT_SECONDS(서버 유지 시간, 기본 40)
결과: out/kit/kit_server_probe.json
실행: kit\\kit.exe apps\\dctwin.base_editor.kit --no-window --/app/file/ignoreUnsavedOnExit=true --exec "<경로>/kit_server_probe.py"
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

import omni.kit.app
import omni.usd

ROOT = Path("D:/Test")
OUT = ROOT / "experiments/omniverse_probe/out/kit/kit_server_probe.json"
PORT = int(os.environ.get("DCT_PORT", "18790"))
SECONDS = float(os.environ.get("DCT_SECONDS", "40"))
res: dict = {"port": PORT, "t_start": time.time()}
sys.path[:0] = [os.environ.get("DCT_PYDEPS", "D:/omniverse-kit/pydeps")]


def log(msg):
    print(f"[kit_server_probe] {msg}", flush=True)


def server_thread(state):
    import websockets

    async def handler(ws):
        async for raw in ws:
            state["requests"] += 1
            await ws.send(json.dumps({"echo": raw, "prims": state.get("prims"), "warp": state.get("warp_result")}))

    async def main():
        async with websockets.serve(handler, "127.0.0.1", PORT):
            state["listening"] = True
            log(f"listening {PORT}")
            while not state["stop"]:
                await asyncio.sleep(0.2)

    asyncio.run(main())


def finish():
    res["t_end"] = time.time()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    log({k: v for k, v in res.items() if k != "trace"})
    omni.kit.app.get_app().post_quit()


async def run():
    state = {"stop": False, "requests": 0, "listening": False}
    try:
        t0 = time.time()
        ctx = omni.usd.get_context()
        await ctx.open_stage_async(str(ROOT / "usd/scenes/hall01.usda"))
        stage = ctx.get_stage()
        state["prims"] = sum(1 for _ in stage.Traverse())
        res["open_stage_s"] = round(time.time() - t0, 2)
        res["prims"] = state["prims"]

        th = threading.Thread(target=server_thread, args=(state,), daemon=True)
        th.start()
        for _ in range(50):
            if state["listening"]:
                break
            await asyncio.sleep(0.1)
        res["listening"] = state["listening"]

        # 서버가 도는 동안 Warp 계산(같은 프로세스)
        import warp as wp

        wp.init()

        @wp.kernel
        def add(a: wp.array(dtype=float), b: wp.array(dtype=float)):
            i = wp.tid()
            a[i] = a[i] + b[i]

        n = 1_000_000
        a = wp.ones(n, dtype=float, device="cuda")
        b = wp.ones(n, dtype=float, device="cuda")
        t1 = time.time()
        for _ in range(100):
            wp.launch(add, dim=n, inputs=[a, b], device="cuda")
        wp.synchronize()
        state["warp_result"] = float(a.numpy()[0])
        res.update({"warp": wp.__version__, "warp_ok": state["warp_result"] == 101.0, "warp_s": round(time.time() - t1, 3)})

        end = time.time() + SECONDS
        while time.time() < end:
            await asyncio.sleep(0.5)  # Kit 갱신 루프를 막지 않고 기다린다
        res["requests"] = state["requests"]
        res["ok"] = bool(res["listening"] and res.get("warp_ok") and state["requests"] > 0)
    except Exception as e:  # noqa: BLE001
        res.update({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]})
    finally:
        state["stop"] = True
        finish()


asyncio.ensure_future(run())
