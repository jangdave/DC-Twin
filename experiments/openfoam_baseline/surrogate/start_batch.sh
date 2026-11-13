#!/bin/bash
# run_batch.py를 WSL 홈에서 실행하고 로그를 ~/surrogate_batch.log에 남긴다. 인자는 그대로 run_batch.py에 넘긴다.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)   # 저장소 위치를 고정하지 않는다(docs/30 M13)
cd ~
exec python3 "$HERE/run_batch.py" "$@" >> ~/surrogate_batch.log 2>&1
