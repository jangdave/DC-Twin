#!/bin/bash
# 수렴 조사용: 같은 사례를 코어 수를 바꿔 몇 회만 돌려, 연속 오류(adjustPhi)가 코어 분할에 따라 달라지는지 본다.
# 사용: bash np_probe.sh <사례 id> <코어 수 ...>
ID=$1; shift
for NP in "$@"; do
  bash /mnt/d/Test/experiments/openfoam_baseline/surrogate/conv_probe.sh $ID 10 $NP > /dev/null 2>&1
  L=~/foam_runs/conv_probe/$ID/log.solver
  echo "np=$NP method=$(grep -E '^method' ~/foam_runs/conv_probe/$ID/system/decomposeParDict | head -1) 반복=$(grep -c '^Time =' $L) 오류=$(grep -c 'FOAM FATAL' $L)"
done
