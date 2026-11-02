#!/bin/bash
# ?�렴 조사?? conv_probe.sh가 만든 ?�업 ?�더?�서 직렬(코어 1�?�?2?�만 ?�려 ?�속 ?�류가 ?�는지 본다.
export WM_PROJECT_DIR=/usr/share/openfoam
cd ~/foam_runs/conv_probe/$1 || exit 1
sed -i 's/^endTime .*/endTime 2;/' system/controlDict
timeout 250 buoyantBoussinesqSimpleFoam > log.serial 2>&1
grep -n -A8 "FATAL" log.serial | head -14
grep -c "^Time =" log.serial
