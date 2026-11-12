#!/usr/bin/env python3
"""samples.json의 샘플을 순서대로 한 번에 하나씩 OpenFOAM(16코어)으로 돌린다. WSL의 python3로 실행한다(Windows 도구 필요 없음).

사용 (nohup): wsl -e bash -lc "cd ~ && nohup setsid python3 /mnt/d/Test/experiments/openfoam_baseline/surrogate/run_batch.py > ~/surrogate_batch.log 2>&1 &"
옵션: --only id ...  --spec 경로  --np 16  --nice 5
- 이미 끝난 샘플(progress.json 의 status done/not_converged)은 건너뛰어, 중단 후 다시 실행하면 이어서 한다.
- 샘플마다: 사례 정의(surrogate/cases/<id>/)를 ~/foam_runs/surrogate/<id>로 복사 -> 메시 -> 계산 -> 수렴 판정 -> extract.py로 results/surrogate/of_<id>.csv
  -> 큰 결과(메시, 필드)는 삭제하고 로그 일부(results/surrogate/log_<id>.txt)와 시간만 남긴다.
- 수렴 판정: log.solver에 "SIMPLE solution converged"가 있으면 converged=true, 반복 한도(사례의 endTime, 3500)까지 가면 false.
- 진행 상황: results/surrogate/progress.json
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path("/mnt/d/Test/experiments/openfoam_baseline")
SUR = ROOT / "surrogate"
RES = ROOT / "results" / "surrogate"
WORK = Path.home() / "foam_runs" / "surrogate"
ENV = dict(os.environ, WM_PROJECT_DIR="/usr/share/openfoam")


def sh(cmd, cwd, log):
    with open(log, "w") as f:
        return subprocess.run(cmd, shell=True, cwd=cwd, env=ENV, stdout=f, stderr=subprocess.STDOUT).returncode


def save(prog):
    (RES / "progress.json").write_text(json.dumps(prog, indent=1, ensure_ascii=False), encoding="utf-8")


def main():
    global RES
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", default=str(SUR / "samples.json"))
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--np", type=int, default=16)
    ap.add_argument("--nice", type=int, default=5)
    ap.add_argument("--cases", default=str(SUR / "cases"), help="사례 정의 폴더(make_cases.py --out-dir)")
    ap.add_argument("--res", default=str(RES), help="결과 폴더(of_<id>.csv, progress.json)")
    ap.add_argument("--init", default=None, help="초기값으로 쓸 끝난 사례 폴더(WSL 경로). mapFields로 옮겨 반복을 줄인다(2026-11-11, docs/33 C단계)")
    a = ap.parse_args()
    RES = Path(a.res)
    RES.mkdir(parents=True, exist_ok=True); WORK.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    samples = [s for s in (data["samples"] if isinstance(data, dict) else data) if not s.get("holdout")]
    pp = RES / "progress.json"
    prog = json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else {}
    for s in samples:
        sid = s["id"]
        if a.only and sid not in a.only:
            continue
        if prog.get(sid, {}).get("status") in ("done", "not_converged"):
            continue
        run = WORK / sid
        shutil.rmtree(run, ignore_errors=True)
        shutil.copytree(Path(a.cases) / sid, run)
        # 줄바꿈이 CRLF로 저장돼 있어도 LF로 바꾼다(CR 문자가 OpenFOAM 사전과 사례 이름에 들어가는 것을 막는다)
        for f in list(run.rglob("*")):
            if f.is_file() and f.suffix != ".npz":
                b = f.read_bytes()
                if b"\r\n" in b:
                    f.write_bytes(b.replace(b"\r\n", b"\n"))
        prog[sid] = {"status": "running", "start": time.strftime("%Y-%m-%d %H:%M:%S")}
        save(prog)
        t0 = time.time()
        n = f"nice -n {a.nice}"
        sh(f"{n} blockMesh", run, run / "log.blockMesh")
        sh(f"{n} topoSet -dict system/topoSetDict.solid", run, run / "log.topoSet.solid")
        sh(f"{n} subsetMesh fluid -patch solidWalls -overwrite", run, run / "log.subsetMesh")
        bp = run / "constant/polyMesh/boundary"
        txt = bp.read_text()
        txt = re.sub(r"(solidWalls\s*\{\s*type\s+)\w+;(\s*inGroups\s+)[^;]*;", r"\1wall;\2List<word> 1(wall);", txt)
        bp.write_text(txt)
        sh(f"{n} topoSet -dict system/topoSetDict.zones", run, run / "log.topoSet.zones")
        sh(f"{n} createPatch -overwrite", run, run / "log.createPatch")
        shutil.rmtree(run / "0", ignore_errors=True); shutil.copytree(run / "0.orig", run / "0")
        sh(f"{n} checkMesh", run, run / "log.checkMesh")
        warm = False
        if a.init:
            # 정상 해에서 출발: 같은 영역의 끝난 사례에서 내부 값을 옮긴다(경계 조건은 이 사례 것). 실패하면 처음 값 그대로
            # 패치 구성이 사례마다 달라(꺼진 공조기, 열린 지붕) -consistent는 못 쓴다. 내부 값만 옮기고 경계는 이 사례 것을 둔다
            (run / "system/mapFieldsDict").write_text("FoamFile { version 2.0; format ascii; class dictionary; object mapFieldsDict; }" + chr(10) + "patchMap ();" + chr(10) + "cuttingPatches ();" + chr(10))
            rc = sh(f"{n} mapFields {a.init} -sourceTime latestTime", run, run / "log.mapFields")
            warm = rc == 0
            if not warm:
                shutil.rmtree(run / "0", ignore_errors=True); shutil.copytree(run / "0.orig", run / "0")
        sh(f"{n} decomposePar -force", run, run / "log.decomposePar")
        t1 = time.time()
        sh(f"{n} mpirun --allow-run-as-root --oversubscribe -np {a.np} buoyantBoussinesqSimpleFoam -parallel", run, run / "log.solver")
        t2 = time.time()
        sh(f"{n} reconstructPar -latestTime", run, run / "log.reconstructPar")
        solver = (run / "log.solver").read_text(errors="ignore")
        iters = len(re.findall(r"^Time = ", solver, re.M))
        converged = "SIMPLE solution converged" in solver
        has_result = any(d.is_dir() and re.fullmatch(r"\d+", d.name) and d.name != "0" for d in run.iterdir())
        status = "failed"
        if has_result:
            rc = sh(f"python3 {ROOT}/extract.py {run} {RES}/of_{sid}", ROOT, run / "extract.out")
            status = "done" if (rc == 0 and converged) else ("not_converged" if rc == 0 else "failed")
        last = [l for l in solver.splitlines() if "Solving for" in l][-12:]
        cells = [l.strip() for l in (run / "log.checkMesh").read_text(errors="ignore").splitlines() if l.strip().startswith("cells:")]
        (RES / f"log_{sid}.txt").write_text("\n".join(cells + last + (solver.splitlines()[-8:] if status == "failed" else [])) + "\n", encoding="utf-8")
        prog[sid] = {"status": status, "converged": converged, "iterations": iters, "solve_wall_s": round(t2 - t1, 1), "total_wall_s": round(time.time() - t0, 1),
                     "cores": a.np, "nice": a.nice, "warm_start": warm, "finished": time.strftime("%Y-%m-%d %H:%M:%S")}
        save(prog)
        shutil.rmtree(run, ignore_errors=True)  # 큰 결과 필드와 메시 삭제
    save(prog)


if __name__ == "__main__":
    main()
