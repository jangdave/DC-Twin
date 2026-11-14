#!/bin/bash
# 옮긴 도구의 연결 파일(docs/30 M12, 2026-11-15). 코드는 sim/openfoam/run_case.sh에 있다. 사례 폴더는 예전처럼 이 폴더의 cases/를 쓴다.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec bash "$HERE/../../sim/openfoam/run_case.sh" "$1" "${2:-16}" "${3:-$HERE/cases}"
