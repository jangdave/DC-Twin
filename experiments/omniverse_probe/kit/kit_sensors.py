"""Kit 안에서 센서 값 생성기(dct_sensors)를 돌려 녹화(.jsonl)를 만든다. 기본은 L1(Warp 열 시뮬레이션).

독립 실행과 같은 코드, 같은 인자, 같은 시드를 쓰므로 결과가 같아야 한다(같은지는 `compare_kit_run.py`로 확인).
scipy는 Kit에 없어서 저장소 밖 `D:/omniverse-kit/pydeps`에 받아 둔다(`kit_hall60.py` 머리말 참고).

환경 변수: DCT_ARGS(dct_sensors 인자), DCT_JSONL(출력 경로)
기본 인자: --scenario cooling_failure --solver l1 --time-scale 0 --quiet
실행: kit\kit.exe apps\dctwin.base_editor.kit --/app/file/ignoreUnsavedOnExit=true --exec "<경로>/kit_sensors.py"
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
import traceback
from pathlib import Path

import omni.kit.app

ROOT = Path("D:/Test")
OUT = Path(os.environ.get("DCT_JSONL", ROOT / "experiments/omniverse_probe/out/kit/sensors_kit.jsonl"))
ARGS = shlex.split(os.environ.get("DCT_ARGS", "--scenario cooling_failure --solver l1 --time-scale 0 --quiet"))
res: dict = {"args": ARGS, "out": str(OUT)}

try:
    sys.path[:0] = [os.environ.get("DCT_PYDEPS", "D:/omniverse-kit/pydeps"), str(ROOT / "experiments/omniverse_probe"), str(ROOT / "sim/sensors")]
    import warp as wp

    res["warp"] = wp.__version__
    from dct_sensors.__main__ import main

    OUT.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    code = main(["--manifest", str(ROOT / "sim/out/sensor_manifest.json"), *ARGS, "--out", str(OUT)])
    res.update({"exit_code": code, "seconds": round(time.time() - t0, 1), "lines": sum(1 for _ in open(OUT, encoding="utf-8")), "ok": code in (0, None)})
except Exception as e:  # noqa: BLE001
    res.update({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]})
finally:
    OUT.with_suffix(".run.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[kit_sensors]", {k: v for k, v in res.items() if k != "trace"}, flush=True)
    omni.kit.app.get_app().post_quit()
