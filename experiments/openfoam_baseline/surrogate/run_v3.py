"""학습 데이터 확장 3차(낮은 부하 s61~s68) OpenFOAM 계산을 이어서 돌린다. expand.py의 1단계와 같은 방식이다.

Windows에서 분리해서 실행한다(창을 닫아도 계속 돌도록):
    cd experiments/omniverse_probe
    Start-Process -WindowStyle Hidden uv -ArgumentList 'run','--python','3.13','python','../openfoam_baseline/surrogate/run_v3.py'
끝난 샘플은 건너뛰므로 중간에 멈춰도 같은 명령으로 이어서 돌린다. 진행: results/surrogate/progress.json, 로그: run_v3.log
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROG = HERE.parent / "results" / "surrogate" / "progress.json"
LOG = HERE / "run_v3.log"


def w(m):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + m + "\n")


def finished():
    samples = [x for x in json.loads((HERE / "samples.json").read_text(encoding="utf-8"))["samples"] if not x.get("holdout")]
    prog = json.loads(PROG.read_text(encoding="utf-8")) if PROG.exists() else {}
    return all(prog.get(x["id"], {}).get("status") in ("done", "not_converged", "failed") for x in samples)


w("3차 시작(낮은 부하 8개)")
for n in range(30):
    if finished():
        break
    subprocess.run([sys.executable, str(HERE / "supervise.py"), "/mnt/d/Test/experiments/openfoam_baseline/surrogate/start_batch.sh",
                    "--spec", "/mnt/d/Test/experiments/openfoam_baseline/surrogate/samples.json"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
    if finished():
        break
    w(f"계산이 끝나지 않고 멈춤, 다시 시작 #{n + 1}")
    time.sleep(10)
w("3차 끝" if finished() else "3차 중단(재시작 한도)")
