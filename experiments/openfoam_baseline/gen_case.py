"""옮긴 도구의 연결 파일(docs/30 M12, 2026-11-15). 코드는 `sim/openfoam/gen_case.py`에 있다.
`import gen_case`(surrogate/make_cases.py)와 예전 명령(`python ../openfoam_baseline/gen_case.py ...`)이 그대로 동작하도록 같은 모듈 객체를 돌려준다."""
import importlib.util
import sys
from pathlib import Path

_p = Path(__file__).resolve().parents[2] / "sim" / "openfoam" / "gen_case.py"
_spec = importlib.util.spec_from_file_location("gen_case", _p)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)

if __name__ == "__main__":
    _m.main()
else:
    sys.modules[__name__] = _m
