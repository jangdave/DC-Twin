"""sim/library.json의 항목마다 센서 녹화(.jsonl)를 만든다(L2: Warp 열 시뮬레이션 + 보정 모델). GPU와 scikit-learn이 필요하다.

    cd experiments/omniverse_probe
    uv run --python 3.13 python ../../scripts/make_sim_library.py [--only supply_20 load_70] [--solver l2]

- 결과: sim/out/recordings/<id>_l2.jsonl (gitignore). 이어서 `cd web/viewer && node tools/build_data.mjs`로 웹 자료로 바꾼다.
- 항목의 config는 센서 생성기의 `--config`(Config 필드를 덮어쓰는 JSON)로 넘긴다. alias 항목은 다른 항목의 녹화를 가리키므로 만들지 않는다.
- 같은 코드, 같은 시드(1)로 만들어 다시 만들면 같은 결과가 나온다.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None, help="이 id만 만든다")
    ap.add_argument("--solver", default="l2", choices=["l0", "l1", "l2"])
    args = ap.parse_args()
    lib = json.loads((ROOT / "sim" / "library.json").read_text(encoding="utf-8"))
    out_dir = ROOT / "sim" / "out" / "recordings"
    out_dir.mkdir(parents=True, exist_ok=True)
    env_path = str(ROOT / "sim" / "sensors")
    failed = 0
    for e in lib["entries"]:
        if "alias" in e or (args.only and e["id"] not in args.only):
            continue
        out = out_dir / f"{e['id']}_{args.solver}.jsonl"
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "cfg.json"
            cfg.write_text(json.dumps(e.get("config", {})), encoding="utf-8")
            cmd = [sys.executable, "-m", "dct_sensors", "--manifest", str(ROOT / "sim" / "out" / "sensor_manifest.json"), "--scenario", e["scenario"],
                   "--solver", args.solver, "--time-scale", "0", "--quiet", "--config", str(cfg), "--out", str(out)]
            print(f"== {e['id']} -> {out.name}", flush=True)
            r = subprocess.run(cmd, env={**__import__("os").environ, "PYTHONPATH": env_path})
            failed += r.returncode != 0
    print("실패", failed, "건" if failed else "없음")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
