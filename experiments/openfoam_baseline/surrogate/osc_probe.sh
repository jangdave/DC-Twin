#!/bin/bash
# 반복 한도 샘플의 흔들림 조사: 학습 계산(run_batch.py)과 같은 조건(정상 해에서 출발)으로 사례 하나를 반복 한도보다 길게 돌리며
# 일정 간격으로 저장하고, 각 시각의 랙 입구 온도와 잔차 이력을 뽑는다(docs/33 7장의 흔들림 확인을 최종 장면에 다시 쓰기 위해, 2026-11-23).
# 사용: wsl -e bash /mnt/d/Test/experiments/openfoam_baseline/surrogate/osc_probe.sh <사례 id> <사례 폴더 이름> <결과 폴더 이름> [반복 수=4500] [저장 간격=250] [코어 수=16]
#   예: osc_probe.sh s01_normal cases_ceil surrogate_ceil_osc
# 출발 해: 환경변수 INIT(WSL 경로, 기본 ~/foam_runs/job_ceil_init). 비우면 처음 값에서 출발한다.
set -e
export WM_PROJECT_DIR=/usr/share/openfoam
ID=$1; CASES=$2; RESNAME=$3; ITERS=${4:-4500}; EVERY=${5:-250}; NP=${6:-16}
INIT=${INIT-$HOME/foam_runs/job_ceil_init}
ROOT=/mnt/d/Test/experiments/openfoam_baseline
RUN=$HOME/foam_runs/osc_$ID
OUT=$ROOT/results/$RESNAME/$ID
rm -rf "$RUN"; mkdir -p "$RUN" "$OUT"; cp -r $ROOT/surrogate/$CASES/$ID/* "$RUN"/; cd "$RUN"
sed -i "s/numberOfSubdomains .*/numberOfSubdomains $NP;/" system/decomposeParDict
sed -i "s/^endTime .*/endTime $ITERS;/; s/^writeInterval .*/writeInterval $EVERY;/; s/^purgeWrite .*/purgeWrite 0;/" system/controlDict
N="nice -n 5"
$N blockMesh > log.blockMesh 2>&1
$N topoSet -dict system/topoSetDict.solid > log.topoSet.solid 2>&1
$N subsetMesh fluid -patch solidWalls -overwrite > log.subsetMesh 2>&1
python3 - <<'EOF'
import re
p = "constant/polyMesh/boundary"
s = open(p).read()
s = re.sub(r"(solidWalls\s*\{\s*type\s+)\w+;(\s*inGroups\s+)[^;]*;", r"\1wall;\2List<word> 1(wall);", s)
open(p, "w").write(s)
EOF
$N topoSet -dict system/topoSetDict.zones > log.topoSet.zones 2>&1
$N createPatch -overwrite > log.createPatch 2>&1
rm -rf 0; cp -r 0.orig 0
if [ -n "$INIT" ]; then  # run_batch.py --init과 같다: 내부 값만 옮기고 경계는 이 사례 것
  printf 'FoamFile { version 2.0; format ascii; class dictionary; object mapFieldsDict; }\npatchMap ();\ncuttingPatches ();\n' > system/mapFieldsDict
  $N mapFields "$INIT" -sourceTime latestTime > log.mapFields 2>&1 || { echo "mapFields 실패, 처음 값에서 출발"; rm -rf 0; cp -r 0.orig 0; }
fi
$N decomposePar -force > log.decomposePar 2>&1
$N mpirun --allow-run-as-root --oversubscribe -np $NP buoyantBoussinesqSimpleFoam -parallel > log.solver 2>&1 || true
python3 - <<EOF
import re
t = open("log.solver", errors="ignore").read()
rows = []
for blk in t.split("\nTime = ")[1:]:
    it = blk.split("\n", 1)[0].strip()
    g = lambda f: (re.search(r"Solving for %s, Initial residual = ([0-9.eE+-]+)" % f, blk) or [None, "nan"])[1]
    rows.append(",".join([it, g("Ux"), g("T"), g("p_rgh"), g("k"), g("epsilon")]))
open("$OUT/residuals.csv", "w").write("iter,Ux,T,p_rgh,k,epsilon\n" + "\n".join(rows) + "\n")
print("converged" if "SIMPLE solution converged" in t else "not_converged", len(rows))
EOF
for T in $(ls processor0 | grep -E '^[0-9]+$' | grep -v '^0$' | sort -n); do
  reconstructPar -time $T > log.rec.$T 2>&1
  V=view_$T; mkdir -p $V; cp case_voxels.npz case_layout.json case_meta.json $V/ 2>/dev/null || true; cp -r $T $V/
  python3 $ROOT/extract.py $V $OUT/t$T > /dev/null 2>&1 || echo "extract 실패 $T"
  rm -rf $V $T
done
cd ~; rm -rf "$RUN"
echo "끝 $ID"
