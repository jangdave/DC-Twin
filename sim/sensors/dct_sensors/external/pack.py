"""외부 CFD 결과(VTK)를 웹 화면과 서버가 읽는 "자료 묶음"(index.json, library.json, rec/<id>.json)으로 바꾼다.

흐름: VTK → 우리 홀 좌표 → 센서 앵커 위치에서 온도 읽기 → 녹화 JSON(정상 상태 300초) → 서버가 `--extra-data-dir`로 준다.

중요한 안전 규칙
- 결과는 저장소에 올라가지 않는 위치에만 쓴다(기본 `sim/out/local_only/external_pack/`). git이 무시하지 않는 위치면 거절한다.
- 공개 사이트에는 들어가지 않는다. 화면은 **로컬 서버가 줄 때만** 이 항목을 본다(서버에 연결해야 보인다).
- 상용 도구의 결과나 화면을 저장소, PR, 영상, 문서에 올리지 않는다(docs/04, CLAUDE.md). 이 모듈은 변환 도구일 뿐이다.

정직하게: 온도 외의 센서(전력, 팬, 급기 온도 등)는 mapping의 case에 있으면 그 값, 없으면 기준(정상 가동) 녹화의 평균으로 채우고
`meta.filled`에 적는다. 정상 상태 한 장면을 300초 동안 같은 값으로 보여 주므로 시간에 따른 변화는 없다.
시각화 목적이며 공학적 정확성을 주장하지 않는다.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np

from ..alarms import AlarmState
from ..config import Config
from . import vtk_legacy
from .mapping import Mapping, MappingError, pick_field, sample_nearest

REPO = Path(__file__).resolve().parents[4]
DEFAULT_PACK = REPO / "sim" / "out" / "local_only" / "external_pack"
ID_RE = re.compile(r"^ext_[a-z0-9_]{1,34}$")
N = 300
SAMPLED = {("rack", "temp_in"), ("rack", "temp_out"), ("crac", "return_temp")}


class PackError(ValueError):
    """만들 수 없다. 메시지는 사용자에게 그대로 보여 줘도 된다."""


def ensure_ignored(path: Path, repo: Path = REPO) -> None:
    """결과를 쓸 위치가 저장소 안이면 git이 무시하는 위치여야 한다(실수로 올라가는 것을 막는다)."""
    path = Path(path).resolve()
    try:
        path.relative_to(repo.resolve())
    except ValueError:
        return  # 저장소 밖
    probe = path / ".probe" if path.is_dir() else path
    try:
        r = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", str(probe)], capture_output=True)
    except FileNotFoundError:
        raise PackError("git을 찾지 못해 이 위치가 저장소에서 제외되는지 확인할 수 없다. 저장소 밖의 폴더를 쓰거나 git을 설치한다") from None
    if r.returncode != 0:
        raise PackError(f"이 위치는 저장소에 올라갈 수 있다: {path}. 외부 도구의 결과는 저장소 밖이나 gitignore된 폴더(예: sim/out/local_only/)에만 둔다")


def _series(v: float) -> list[float]:
    return [round(float(v), 3)] * N


def build_case(vtk_path, mapping: Mapping, sensors: list[dict], anchors: dict, baseline: dict, case_id: str, title: str, note: str, cfg: Config | None = None) -> tuple[dict, dict]:
    """(녹화 JSON, 색인 항목)을 만든다."""
    cfg = cfg or Config()
    if not ID_RE.match(case_id):
        raise PackError("id는 ext_로 시작하고 소문자, 숫자, 밑줄만 쓴 38자 이하여야 한다(예: ext_case1)")
    ds = vtk_legacy.read(vtk_path)
    values, pts = pick_field(ds, mapping.field, mapping.location)
    pts_cm = mapping.to_hall_cm(pts)
    temp = mapping.to_celsius(values)
    by_key = {(s["equipment"], s["metric"]): s for s in sensors}
    q_keys, q_pos = [], []
    for a in anchors["anchors"]:
        k = (a["equipment"], a["metric"])
        kind = "rack" if k[0].startswith("rack_") else "crac" if k[0].startswith("crac_") else None
        if (kind, k[1]) in SAMPLED and k in by_key:
            q_keys.append(k)
            q_pos.append(a["pos_cm"])
    vals, dist = sample_nearest(pts_cm, temp, np.array(q_pos, dtype=np.float64), mapping.max_distance_cm)
    bad = [f"{k[0]}/{k[1]}" for k, v in zip(q_keys, vals) if not np.isfinite(v)]
    if bad:
        lo, hi = pts_cm.min(axis=0), pts_cm.max(axis=0)
        raise PackError(f"앵커 {len(bad)}개가 {mapping.max_distance_cm:g} cm 안에 값이 없다(예: {', '.join(bad[:3])}). "
                        f"변환한 데이터 범위(cm) x {lo[0]:.0f}~{hi[0]:.0f}, y {lo[1]:.0f}~{hi[1]:.0f}, z {lo[2]:.0f}~{hi[2]:.0f}. "
                        "mapping의 unit, axes, origin_cm을 확인한다(`inspect`로 파일의 좌표 범위를 본다)")
    sampled = {k: float(v) for k, v in zip(q_keys, vals)}
    coverage = {"anchors": len(q_keys), "maxDistanceCm": round(float(dist.max()), 2), "meanDistanceCm": round(float(dist.mean()), 2)}

    case = mapping.case
    rack_p = case.get("rack_power_kw")
    fan = case.get("fan", {})
    filled: dict[str, str] = {}
    out_values: dict[str, list[float]] = {}
    for s in sensors:
        eq, metric = s["equipment"], s["metric"]
        key = (eq, metric)
        kind = "rack" if eq.startswith("rack_") else "crac"
        if key in sampled:
            v, src = sampled[key], "cfd"
        elif metric == "power" and rack_p is not None:
            if isinstance(rack_p, dict):
                has = eq in rack_p
                v = float(rack_p[eq]) if has else float(np.mean(baseline["values"][s["sensorId"]]))
                src = "case" if has else "baseline"  # 표에 없는 랙은 기준 녹화 값
            else:
                v, src = float(rack_p), "case"
        elif metric == "fan_speed" and fan:
            v, src = float(fan.get(eq, 1.0)) * 100.0, "case"
        elif metric == "supply_temp" and "supply_temp" in case:
            v, src = float(case["supply_temp"]) + cfg.crac_supply_rise * (1.0 - float(fan.get(eq, 1.0))), "case"
        else:
            v, src = float(np.mean(baseline["values"][s["sensorId"]])), "baseline"
        out_values[s["sensorId"]] = _series(v)
        filled.setdefault(f"{kind}/{metric}", src)
        if filled[f"{kind}/{metric}"] != src:
            filled[f"{kind}/{metric}"] = "mixed"

    # 알람은 같은 판정 규칙(연속 횟수, 히스테리시스)으로 계산한다. 값이 일정하므로 처음에 한 번 판정이 바뀐다.
    alarms = []
    for s in sensors:
        st = AlarmState(s.get("warn"), s.get("critical"), s.get("direction", "high"), cfg.hysteresis, cfg.consecutive)
        for t in range(N):
            tr = st.update(out_values[s["sensorId"]][t])
            if tr:
                alarms.append({"t": t, "sensorId": s["sensorId"], "from": tr[0], "to": tr[1], "value": out_values[s["sensorId"]][t]})
    alarms.sort(key=lambda a: a["t"])

    # 집계는 같은 식(11 데이터 규격 9장)으로 합친다. 냉각 전력은 기준 녹화의 평균(급기 온도가 case에 있으면 효율 가정을 적용).
    it = sum(out_values[s["sensorId"]][0] for s in sensors if s["metric"] == "power" and s["equipment"].startswith("rack_"))
    cool = float(np.mean(baseline["aggregates"]["cooling_power"]))
    if "supply_temp" in case:
        cool *= min(max(1.0 - cfg.cooling_gain_per_c * (float(case["supply_temp"]) - cfg.t_supply_ref), 0.6), 1.3)
    fac = it * (1 + cfg.loss_ratio) + cool
    energy = [round(fac * (t + 1) / 3600.0, 4) for t in range(N)]
    aggregates = {"it_power": [round(it, 3)] * N, "cooling_power": [round(cool, 3)] * N, "facility_power": [round(fac, 3)] * N,
                  "pue": [round(fac / it, 3) if it > 0 else 0.0] * N, "energy_kwh": energy}
    rec = {
        "version": 1, "scenario": case_id, "startTs": baseline["startTs"], "dt": 1, "n": N, "values": out_values, "est": {},
        "aggregates": aggregates, "alarms": alarms, "events": [],
        "meta": {"source": "external", "tool": mapping.tool, "coverage": coverage, "filled": filled, "steadyState": True},
    }
    entry = {"id": case_id, "title": title, "note": note, "group": "external", "source": "external", "tool": mapping.tool, "n": N}
    return rec, entry


def write_pack(pack_dir: Path, rec: dict, entry: dict, repo: Path = REPO) -> Path:
    """묶음 폴더에 녹화와 색인을 쓴다(같은 id가 있으면 바꾼다)."""
    pack_dir = Path(pack_dir)
    pack_dir.mkdir(parents=True, exist_ok=True)
    ensure_ignored(pack_dir, repo)
    (pack_dir / "rec").mkdir(exist_ok=True)
    text = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
    (pack_dir / "rec" / f"{entry['id']}.json").write_text(text, encoding="utf-8")
    entry = {**entry, "bytes": len(text.encode("utf-8"))}
    idx_path = pack_dir / "index.json"
    index = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else []
    index = [e for e in index if e["id"] != entry["id"]] + [entry]
    idx_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    (pack_dir / "library.json").write_text(json.dumps({"version": 1, "groups": [{"id": "external", "title": "외부 솔버 결과 (로컬 전용)", "note": "이 컴퓨터의 서버가 줄 때만 보인다. 공개 사이트와 저장소에는 없다."}]}, ensure_ascii=False), encoding="utf-8")
    return pack_dir
