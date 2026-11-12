"""장면 USD에서 형상을 읽어 layout.json으로 저장한다. hall60_sim.read_hall을 그대로 쓴다(읽기만 함).
실행: experiments/omniverse_probe 폴더에서  uv run --python 3.13 python ../openfoam_baseline/export_layout.py
"""
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "omniverse_probe"))
import hall60_sim as h

# 인자: [장면 USD] [저장 파일 이름]. 기본은 hall01.usda -> layout.json. CAC 보기용: _hall01_cac.usda layout_cac.json (docs/34)
scene = Path(sys.argv[1]) if len(sys.argv) > 1 else h.ROOT / "usd" / "scenes" / "hall01.usda"
out_name = sys.argv[2] if len(sys.argv) > 2 else "layout.json"
hall = h.read_hall(scene)
(HERE / out_name).write_text(json.dumps(hall, indent=1, ensure_ascii=False, default=float), encoding="utf-8")
print({k: (len(v) if isinstance(v, list) else v) for k, v in hall.items()})
