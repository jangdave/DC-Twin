"""외부 CFD 결과를 우리 가상 홀 좌표와 센서로 옮기는 약속(mapping.json)과, 앵커 위치에서 값을 읽는 계산.

mapping.json 예(모든 항목은 선택, 없으면 아래 기본값):
{
  "tool": "외부 솔버 이름(화면에 보임)",
  "unit": "m",                       // VTK 좌표의 길이 단위: m, cm, mm
  "axes": ["x", "y", "z"],           // 우리 홀의 X, Y, Z가 VTK의 어느 축인가. "-y"처럼 부호를 붙여 뒤집을 수 있다
  "origin_cm": [0, 0, 0],            // 위 변환 뒤에 더하는 이동(cm). 도구의 원점과 우리 홀 원점이 다를 때
  "field": "T",                      // 온도가 들어 있는 값 이름
  "location": "auto",                // point(점 값), cell(셀 값), auto(점 값이 있으면 점, 없으면 셀)
  "temperature_unit": "C",           // C 또는 K
  "max_distance_cm": 30,             // 앵커에서 이 거리 안에 값이 없으면 실패한다(좌표가 어긋났다는 신호)
  "case": {                          // 외부 계산의 조건(없으면 그 센서는 기준 녹화 값으로 채우고 표시한다)
    "rack_power_kw": 8.0,            // 숫자 하나(모든 랙) 또는 {"rack_01": 8.2, ...}
    "fan": {"crac_01": 1.0},         // CRAC 팬 비율(0~1). 적지 않은 CRAC는 1
    "supply_temp": 18.0              // 급기 온도(도)
  }
}
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from dataclasses import field as dc_field
from pathlib import Path

import numpy as np

UNIT_TO_CM = {"m": 100.0, "cm": 1.0, "mm": 0.1}
KNOWN = {"tool", "unit", "axes", "origin_cm", "field", "location", "temperature_unit", "max_distance_cm", "case"}
CASE_KNOWN = {"rack_power_kw", "fan", "supply_temp"}


class MappingError(ValueError):
    """mapping.json이 틀렸다. 메시지는 사용자에게 그대로 보여 줘도 된다."""


@dataclass
class Mapping:
    tool: str = "외부 솔버"
    unit: str = "m"
    axes: tuple[str, str, str] = ("x", "y", "z")
    origin_cm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    field: str = "T"
    location: str = "auto"
    temperature_unit: str = "C"
    max_distance_cm: float = 30.0
    case: dict = dc_field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict) -> "Mapping":
        if not isinstance(d, dict):
            raise MappingError("mapping은 JSON 객체여야 한다")
        extra = set(d) - KNOWN
        if extra:
            raise MappingError(f"알 수 없는 항목(오타?): {', '.join(sorted(extra))}")
        m = cls()
        for k in ("tool", "field", "location", "temperature_unit"):
            if k in d:
                setattr(m, k, d[k])
        if "unit" in d:
            m.unit = d["unit"]
        if m.unit not in UNIT_TO_CM:
            raise MappingError(f"unit은 m, cm, mm 중 하나여야 한다: {m.unit}")
        if m.location not in ("point", "cell", "auto"):
            raise MappingError("location은 point, cell, auto 중 하나여야 한다")
        if m.temperature_unit not in ("C", "K"):
            raise MappingError("temperature_unit은 C 또는 K여야 한다")
        if not isinstance(m.tool, str) or not m.tool.strip() or len(m.tool) > 60:
            raise MappingError("tool은 60자 이하의 이름이어야 한다")
        if "axes" in d:
            axes = d["axes"]
            letters = sorted(str(a).lstrip("-+") for a in axes) if isinstance(axes, list) and len(axes) == 3 else []
            if letters != ["x", "y", "z"]:
                raise MappingError('axes는 x, y, z를 한 번씩 쓴 세 항목이어야 한다(예: ["x", "-y", "z"])')
            m.axes = tuple(str(a) for a in axes)
        if "origin_cm" in d:
            o = d["origin_cm"]
            if not (isinstance(o, list) and len(o) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in o)):
                raise MappingError("origin_cm은 숫자 세 개여야 한다")
            m.origin_cm = tuple(float(v) for v in o)
        if "max_distance_cm" in d:
            v = d["max_distance_cm"]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 < v <= 500:
                raise MappingError("max_distance_cm은 0 초과 500 이하여야 한다")
            m.max_distance_cm = float(v)
        case = d.get("case", {})
        if not isinstance(case, dict) or set(case) - CASE_KNOWN:
            raise MappingError(f"case에는 {', '.join(sorted(CASE_KNOWN))}만 쓸 수 있다")
        m.case = case
        return m

    @classmethod
    def load(cls, path) -> "Mapping":
        try:
            return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            raise MappingError(f"JSON 형식이 아니다: {e}") from None

    def to_hall_cm(self, points: np.ndarray) -> np.ndarray:
        """VTK 좌표(N,3)를 우리 홀 좌표(cm)로 바꾼다."""
        pts = np.asarray(points, dtype=np.float64) * UNIT_TO_CM[self.unit]
        idx = {"x": 0, "y": 1, "z": 2}
        out = np.empty_like(pts)
        for k, a in enumerate(self.axes):
            sign = -1.0 if a.startswith("-") else 1.0
            out[:, k] = sign * pts[:, idx[a.lstrip("-+")]]
        return out + np.array(self.origin_cm)

    def to_celsius(self, v: np.ndarray) -> np.ndarray:
        return v - 273.15 if self.temperature_unit == "K" else v


def pick_field(ds, name: str, location: str):
    """온도 값과 그 위치(점 좌표 N,3)를 돌려준다. 값 이름이나 위치가 없으면 MappingError."""
    from .vtk_legacy import VtkError

    sources = []
    if location in ("point", "auto"):
        sources.append(("point", ds.point_data))
    if location in ("cell", "auto"):
        sources.append(("cell", ds.cell_data))
    for loc, d in sources:
        if name in d:
            a = d[name]
            if a.ndim != 1:
                raise MappingError(f"'{name}'은 성분이 {a.shape[1]}개다. 온도는 성분 하나여야 한다")
            pts = ds.points if loc == "point" else ds.cell_centers()
            if len(a) != len(pts):
                raise MappingError(f"'{name}'의 개수({len(a)})가 {loc} 개수({len(pts)})와 다르다")
            return a.astype(np.float64), pts
    have = sorted(ds.point_data) + sorted(ds.cell_data)
    raise MappingError(f"값 이름 '{name}'을 찾지 못했다(location={location}). 파일에 있는 값: {', '.join(have) or '없음'}")


def sample_nearest(points_cm: np.ndarray, values: np.ndarray, query_cm: np.ndarray, max_distance_cm: float):
    """질의 위치마다 가장 가까운 점의 값을 읽는다. (값, 거리) 배열. 거리가 max_distance_cm를 넘으면 값은 NaN."""
    vals = np.empty(len(query_cm))
    dist = np.empty(len(query_cm))
    for i, q in enumerate(query_cm):
        d2 = ((points_cm - q) ** 2).sum(axis=1)
        j = int(np.argmin(d2))
        dist[i] = float(np.sqrt(d2[j]))
        vals[i] = values[j] if dist[i] <= max_distance_cm else np.nan
    return vals, dist
