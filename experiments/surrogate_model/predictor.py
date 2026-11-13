"""옮긴 모듈의 연결 파일(docs/30 M12, 2026-11-13). 코드는 `sim/thermal/dct_thermal/predictor.py`에 있다.
`import predictor`을 쓰는 실험 스크립트와 저장된 모델(pickle의 모듈 이름 `predictor`)이 그대로 동작하도록 같은 모듈 객체를 돌려준다
(별칭이라 `predictor.X = ...`처럼 모듈 값을 바꾸는 코드도 그대로 맞다)."""
import sys
from pathlib import Path

_p = str(Path(__file__).resolve().parents[2] / "sim" / "thermal")
if _p not in sys.path:
    sys.path.insert(0, _p)
from dct_thermal import predictor as _m  # noqa: E402

sys.modules[__name__] = _m
