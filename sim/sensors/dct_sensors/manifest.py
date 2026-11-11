"""센서 매니페스트(`sim/out/sensor_manifest.json`) 읽기와 홀 배치 규칙.

매니페스트는 `scripts/usd_tools/build_manifest.py`가 USD 장면에서 만든다(ADR-005).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

ROW_RE = re.compile(r"/Row(\d{2})/Rack_(\d{2,})$")
CRAC_RE = re.compile(r"/Cooling/CRAC_(\d{2,})$")


@dataclass(frozen=True)
class Sensor:
    sensor_id: str
    topic: str
    equipment_path: str
    equipment_type: str
    metric: str
    unit: str
    value_range: tuple[float, float]
    warn: float | None
    critical: float | None
    direction: str  # "high"(높을수록 위험) 또는 "low"(낮을수록 위험)

    @property
    def key(self) -> str:
        """`rack_01/temp_in`처럼 장비와 측정 종류로 센서를 가리키는 이름(주소의 뒷부분)."""
        return self.topic.split("/", 3)[3]

    @property
    def equipment(self) -> str:
        return self.key.split("/")[0]


class Manifest:
    def __init__(self, data: dict):
        if data.get("version") != 1:
            raise ValueError(f"지원하지 않는 매니페스트 버전: {data.get('version')}")
        self.hall: str = data["hall"]
        self.sensors: list[Sensor] = []
        for s in data["sensors"]:
            self.sensors.append(Sensor(
                sensor_id=s["sensorId"], topic=s["topic"], equipment_path=s["equipmentPath"], equipment_type=s["equipmentType"],
                metric=s["metric"], unit=s["unit"], value_range=tuple(s.get("range", (float("-inf"), float("inf")))),
                warn=s.get("warn"), critical=s.get("critical"), direction=s.get("direction", "high"),
            ))
        self.by_id = {s.sensor_id: s for s in self.sensors}
        self.by_key = {s.key: s for s in self.sensors}
        self.racks: dict[str, tuple[int, int]] = {}   # 이름(rack_01) -> (줄 번호, 번호)
        self.cracs: list[str] = []                    # 이름(crac_01), 번호 순
        for s in self.sensors:
            m = ROW_RE.search(s.equipment_path)
            if m:
                self.racks.setdefault(s.equipment, (int(m.group(1)), int(m.group(2))))
            if CRAC_RE.search(s.equipment_path) and s.equipment not in self.cracs:
                self.cracs.append(s.equipment)
        self.cracs.sort()
        self.rack_names = sorted(self.racks, key=lambda n: self.racks[n][1])
        self.n_rows = max((r for r, _ in self.racks.values()), default=0)


def load_manifest(path: str | Path) -> Manifest:
    return Manifest(json.loads(Path(path).read_text(encoding="utf-8")))


@dataclass(frozen=True)
class Layout:
    """줄 번호와 CRAC 번호로 열기 통로(= 담당 CRAC)를 정한다. 09 규격 11장의 배치 규칙을 따른다.

    줄 2개가 냉기 통로를 사이에 두고 마주 보고, 줄 사이와 바깥에 열기 통로가 있다.
    줄 r(1부터)의 뒷면은 열기 통로 r // 2에 닿는다. CRAC는 열기 통로마다 양쪽 벽에 1기씩이고,
    번호는 서쪽 벽 통로 0..n-1, 동쪽 벽 통로 0..n-1 순서다.
    """

    n_rows: int
    per_side: int

    @classmethod
    def from_manifest(cls, m: Manifest) -> "Layout":
        per_side = max(1, len(m.cracs) // 2)
        lay = cls(m.n_rows, per_side)
        if m.n_rows // 2 + 1 != per_side:
            raise ValueError(f"줄 {m.n_rows}개와 CRAC {len(m.cracs)}기가 배치 규칙과 맞지 않는다(열기 통로 {m.n_rows // 2 + 1}개, 한쪽 CRAC {per_side}기)")
        return lay

    def aisle_of_row(self, row: int) -> int:
        return row // 2

    def aisle_of_crac(self, crac_no: int) -> int:
        return (crac_no - 1) % self.per_side

    def cracs_for_aisle(self, aisle: int) -> list[int]:
        return [aisle + 1, aisle + 1 + self.per_side]
