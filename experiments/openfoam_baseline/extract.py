"""옮긴 도구의 연결 파일(docs/30 M12, 2026-11-15). 코드는 `sim/openfoam/extract.py`에 있다. 예전 명령(`python3 .../openfoam_baseline/extract.py ...`)이 그대로 돈다."""
import runpy
import sys
from pathlib import Path

_p = Path(__file__).resolve().parents[2] / "sim" / "openfoam" / "extract.py"
sys.argv[0] = str(_p)
runpy.run_path(str(_p), run_name="__main__")
