#!/bin/bash
# 사례 폴더(cases/<이름>)를 WSL 홈(~/foam_runs/<이름>)으로 복사해서 메시 만들기 -> 계산 -> 결과 뽑기까지 한다.
# 사용: wsl -e bash -lc "bash /mnt/d/Test/experiments/openfoam_baseline/run_case.sh <이름> [코어 수=16]"
set -e
export WM_PROJECT_DIR=/usr/share/openfoam   # 이 설치(Ubuntu 패키지)는 환경 파일 없이 이 변수만 필요하다
NAME=$1; NP=${2:-16}
SRC=/mnt/d/Test/experiments/openfoam_baseline/cases/$NAME
RUN=$HOME/foam_runs/$NAME
rm -rf "$RUN"; mkdir -p "$RUN"; cp -r "$SRC"/* "$RUN"/; cd "$RUN"
sed -i "s/numberOfSubdomains .*/numberOfSubdomains $NP;/" system/decomposeParDict
# 나누는 모양도 코어 수에 맞춘다(16이 아니면 (2 4 2)가 맞지 않아 decomposePar가 멈춘다)
case $NP in 4) N="2 2 1";; 8) N="2 2 2";; 16) N="2 4 2";; 32) N="4 4 2";; *) N="";; esac
[ -n "$N" ] && sed -i "s/n ([0-9 ]*);/n ($N);/" system/decomposeParDict
T0=$(date +%s)
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
checkMesh > log.checkMesh 2>&1 || true
T1=$(date +%s)
decomposePar -force > log.decomposePar 2>&1
mpirun --allow-run-as-root --oversubscribe -np $NP buoyantBoussinesqSimpleFoam -parallel > log.solver 2>&1 || true
T2=$(date +%s)
reconstructPar -latestTime > log.reconstructPar 2>&1 || true
echo "mesh_s=$((T1-T0)) solve_s=$((T2-T1)) cores=$NP" | tee timing.txt
