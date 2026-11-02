#!/bin/bash
# 수렴 조사용: 사례 하나를 중간 결과(500회마다) 저장하면서 계산하고, 각 시각의 랙 입구 온도를 뽑는다.
# 사용: wsl -e bash /mnt/d/Test/experiments/openfoam_baseline/surrogate/conv_probe.sh <사례 id> [반복 수=3500] [코어 수=16] [추가 인자: gen_case 대신 이미 만든 사례를 쓴다]
# 환경변수 DECOMP_N="nx ny nz"로 영역 분할을 바꿀 수 있다(곱이 코어 수와 같아야 함).
set -e
export WM_PROJECT_DIR=/usr/share/openfoam
ID=$1; ITERS=${2:-3500}; NP=${3:-16}
ROOT=/mnt/d/Test/experiments/openfoam_baseline
RUN=$HOME/foam_runs/conv_probe/$ID
OUT=$ROOT/results/surrogate/convprobe/$ID
rm -rf "$RUN"; mkdir -p "$RUN" "$OUT"; cp -r $ROOT/surrogate/cases/$ID/* "$RUN"/; cd "$RUN"
sed -i "s/numberOfSubdomains .*/numberOfSubdomains $NP;/" system/decomposeParDict
if [ -n "$DECOMP_N" ]; then sed -i "s/n ([0-9 ]*)/n ($DECOMP_N)/" system/decomposeParDict; fi  # 분할 방식 바꿔 보기(예: DECOMP_N="4 4 1")
sed -i "s/^endTime .*/endTime $ITERS;/; s/^writeInterval .*/writeInterval 500;/; s/^purgeWrite .*/purgeWrite 0;/" system/controlDict
blockMesh > log.blockMesh 2>&1
topoSet -dict system/topoSetDict.solid > log.topoSet.solid 2>&1
subsetMesh fluid -patch solidWalls -overwrite > log.subsetMesh 2>&1
python3 - <<'EOF'
import re
p = "constant/polyMesh/boundary"
s = open(p).read()
s = re.sub(r"(solidWalls\s*\{\s*type\s+)\w+;(\s*inGroups\s+)[^;]*;", r"\1wall;\2List<word> 1(wall);", s)
open(p, "w").write(s)
EOF
topoSet -dict system/topoSetDict.zones > log.topoSet.zones 2>&1
createPatch -overwrite > log.createPatch 2>&1
rm -rf 0; cp -r 0.orig 0
decomposePar -force > log.decomposePar 2>&1
nice -n 5 mpirun --allow-run-as-root --oversubscribe -np $NP buoyantBoussinesqSimpleFoam -parallel > log.solver 2>&1 || true
# 잔차 이력(반복마다 T, p_rgh 첫 잔차)을 저장
python3 - <<EOF
import re
t = open("log.solver", errors="ignore").read()
rows = []
for blk in t.split("\nTime = ")[1:]:
    it = blk.split("\n", 1)[0].strip()
    g = lambda f: (re.search(r"Solving for %s, Initial residual = ([0-9.eE+-]+)" % f, blk) or [None, "nan"])[1]
    rows.append(",".join([it, g("Ux"), g("T"), g("p_rgh"), g("k")]))
open("$OUT/residuals.csv", "w").write("iter,Ux,T,p_rgh,k\n" + "\n".join(rows) + "\n")
EOF
for T in $(ls -d [0-9]* | grep -v '^0$' | grep -v processor | sort -n); do :; done
for T in $(ls processor0 | grep -E '^[0-9]+$' | grep -v '^0$' | sort -n); do
  reconstructPar -time $T > log.rec.$T 2>&1
  V=view_$T; mkdir -p $V; cp case_voxels.npz case_layout.json $V/; cp -r $T $V/
  python3 $ROOT/extract.py $V $OUT/t$T > /dev/null 2>&1 || echo "extract 실패 $T"
  rm -rf $V $T
done
echo done
