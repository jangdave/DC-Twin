"""DC-Twin USD 규칙 검증 도구.

규칙 원문: `.claude/skills/usd-conventions/SKILL.md`

사용 (scripts/usd_tools 폴더에서):
    uv run --python 3.13 python validate_usd.py ../../usd/scenes/hall01.usda
    uv run --python 3.13 python validate_usd.py --kind asset ../../usd/assets/rack.usda

종료 코드: 오류가 있으면 1, 없으면 0 (--strict이면 경고도 오류로 본다).
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from pxr import Sdf, Usd, UsdGeom

from dct_ids import sensor_id_from_path

# --- 규칙 값 ---------------------------------------------------------------
METERS_PER_UNIT = 0.01  # 단위 cm
UP_AXIS = "Z"
ROOT_NAME = "DC"
ASSET_TYPES = {"rack", "server", "crac", "pdu", "rpp", "sensor", "shell", "containment", "vent", "building", "outdoor"}
SENSOR_REQUIRED_TYPES = {"rack", "crac", "pdu"}  # 장면(scene)에서 센서 앵커가 하나 이상 있어야 하는 종류
EQUIPMENT_CODES = {"Rack": "RK", "CRAC": "CR", "PDU": "PD"}  # 센서 ID의 장비 코드 (09 규격 5장)
ZONES = {"cold_aisle", "hot_aisle"}
SENSOR_ID_RE = re.compile(r"^H\d{2}(-[A-Z0-9]+)+$")  # 예: H01-R01-RK01-TEMP-IN

# 종류별로 허용하는 prim 경로
PATH_RULES = {
    "rack": re.compile(r"^/DC/Hall\d{2}/Row\d{2}/Rack_\d{2,}$"),
    "server": re.compile(r"^/DC/Hall\d{2}/Row\d{2}/Rack_\d{2,}/Server_U\d{2,}$"),
    "crac": re.compile(r"^/DC/Hall\d{2}/Cooling/CRAC_\d{2,}$"),
    "pdu": re.compile(r"^/DC/Hall\d{2}/Power/PDU_\d{2,}$"),
    "rpp": re.compile(r"^/DC/Hall\d{2}/Power/RPP_\d{2,}$"),  # 줄 끝 분전반(센서 없음, docs/35)
    "sensor": re.compile(r"^/DC/Hall\d{2}/(Row\d{2}/Rack_\d{2,}|Cooling/CRAC_\d{2,}|Power/PDU_\d{2,})/Anchors/Sensor_[A-Z0-9_]+$"),
    "shell": re.compile(r"^/DC/Hall\d{2}/Shell/[A-Za-z0-9_]+$"),
    "containment": re.compile(r"^/DC/Hall\d{2}/Containment/[A-Za-z0-9_]+$"),
    "vent": re.compile(r"^/DC/Hall\d{2}/Vents/Vent_\d{2,}$"),
    "building": re.compile(r"^/DC/Building\d{2}$"),  # 09 규격 12장
    "outdoor": re.compile(r"^/DC/Building\d{2}/Outdoor(/[A-Za-z0-9_]+)?$"),  # Outdoor 자신 또는 바로 아래 설비
}
HALL_RE = re.compile(r"^Hall\d{2}$")
BUILDING_RE = re.compile(r"^Building\d{2}$")
BUILDING_CHILD_RE = re.compile(r"^(Exterior|Floors|Outdoor)$")
HALL_CHILD_RE = re.compile(r"^(Row\d{2}|Cooling|Power|Containment|Shell|Vents|Looks|Tour)$")
# 이름만 보고 "이건 장비다"라고 판단하는 패턴 (assetType이 빠졌는지 찾는 용도)
EQUIPMENT_NAME_RE = re.compile(r"^(Rack|Server_U|CRAC|PDU)_?\d+$")


@dataclass(frozen=True)
class Finding:
    level: str  # "ERROR" 또는 "WARN"
    rule: str
    path: str
    message: str

    def __str__(self) -> str:
        return f"[{self.level}] {self.rule} {self.path}  {self.message}"


def _get_str(prim: Usd.Prim, name: str):
    attr = prim.GetAttribute(name)
    if not attr or not attr.HasAuthoredValue():
        return None, None
    return attr.Get(), attr.GetTypeName()


def validate_stage(stage: Usd.Stage, kind: str = "scene") -> list[Finding]:
    """열린 스테이지를 검사해 위반 사항 목록을 돌려준다."""
    findings: list[Finding] = []

    def err(rule: str, path: str, msg: str) -> None:
        findings.append(Finding("ERROR", rule, path, msg))

    def warn(rule: str, path: str, msg: str) -> None:
        findings.append(Finding("WARN", rule, path, msg))

    # U101 단위
    if not stage.HasAuthoredMetadata("metersPerUnit"):
        err("U101", "/", "metersPerUnit이 지정되지 않았다 (cm 단위: 0.01)")
    elif abs(UsdGeom.GetStageMetersPerUnit(stage) - METERS_PER_UNIT) > 1e-9:
        err("U101", "/", f"단위가 cm(0.01)가 아니다: {UsdGeom.GetStageMetersPerUnit(stage)}")

    # U102 위쪽 축
    if not stage.HasAuthoredMetadata("upAxis"):
        err("U102", "/", "upAxis가 지정되지 않았다 (Z)")
    elif UsdGeom.GetStageUpAxis(stage) != UP_AXIS:
        err("U102", "/", f"upAxis가 Z가 아니다: {UsdGeom.GetStageUpAxis(stage)}")

    # U103 기본 prim
    default_prim = stage.GetDefaultPrim()
    if not default_prim:
        err("U103", "/", "defaultPrim이 지정되지 않았다")
    elif kind == "scene" and default_prim.GetName() != ROOT_NAME:
        err("U103", str(default_prim.GetPath()), f"장면의 defaultPrim은 '{ROOT_NAME}'여야 한다")

    if kind == "asset" and default_prim:
        if not default_prim.GetAttribute("dct:assetType").HasAuthoredValue():
            err("U201", str(default_prim.GetPath()), "에셋의 기본 prim에 dct:assetType이 없다")

    sensor_ids: dict[str, str] = {}
    anchors_of: dict[str, int] = {}
    equipment: list[tuple[str, str]] = []

    for prim in stage.Traverse():
        path = str(prim.GetPath())
        name = prim.GetName()

        # U301 계층 이름 (장면에서만): /DC 바로 아래는 Hall## 또는 Building##,
        # Hall 아래는 Row##/Cooling/Power/..., Building 아래는 Exterior/Floors/Outdoor
        if kind == "scene":
            parent = str(prim.GetParent().GetPath())
            if parent == f"/{ROOT_NAME}" and not (HALL_RE.match(name) or BUILDING_RE.match(name)):
                err("U301", path, f"/{ROOT_NAME} 바로 아래 이름은 Hall## 또는 Building## 형식이어야 한다")
            elif prim.GetParent().GetParent() and str(prim.GetParent().GetParent().GetPath()) == f"/{ROOT_NAME}":
                grand = prim.GetParent().GetName()
                if HALL_RE.match(grand) and not HALL_CHILD_RE.match(name):
                    err("U301", path, "Hall 바로 아래 이름은 Row##, Cooling, Power, Containment, Shell, Vents, Looks, Tour 중 하나여야 한다")
                elif BUILDING_RE.match(grand) and not BUILDING_CHILD_RE.match(name):
                    err("U301", path, "Building 바로 아래 이름은 Exterior, Floors, Outdoor 중 하나여야 한다")

        asset_type, type_name = _get_str(prim, "dct:assetType")

        # U202 이름은 장비인데 assetType이 없음
        if asset_type is None and EQUIPMENT_NAME_RE.match(name):
            err("U202", path, "장비 이름인데 dct:assetType이 없다")

        if asset_type is not None:
            # U203 타입/값
            if type_name != Sdf.ValueTypeNames.Token:
                err("U203", path, f"dct:assetType은 token이어야 한다 (현재 {type_name})")
            if asset_type not in ASSET_TYPES:
                err("U203", path, f"dct:assetType 값이 올바르지 않다: '{asset_type}' (허용: {sorted(ASSET_TYPES)})")
            # U302 종류별 경로 (장면에서만)
            elif kind == "scene" and not PATH_RULES[asset_type].match(path):
                err("U302", path, f"{asset_type}의 경로 규칙과 맞지 않다 ({PATH_RULES[asset_type].pattern})")

        # 센서 앵커 (09 규격 4장): U402 센서 ID, U403 중복, U404 metric/unit
        sensor_id, sid_type = _get_str(prim, "dct:sensorId")
        if asset_type == "sensor":
            equip = path.rsplit("/Anchors/", 1)[0]
            anchors_of[equip] = anchors_of.get(equip, 0) + 1
            metric, _ = _get_str(prim, "dct:metric")
            unit, _ = _get_str(prim, "dct:unit")
            if not metric or not unit:
                err("U404", path, "센서 앵커에는 dct:metric과 dct:unit이 필요하다")
            elif name != f"Sensor_{str(metric).upper()}":
                err("U404", path, f"앵커 이름은 Sensor_<METRIC>이어야 한다 (Sensor_{str(metric).upper()})")
            if kind == "scene":
                if sensor_id is None:
                    err("U402", path, "장면의 센서 앵커에는 dct:sensorId가 필요하다")
        if sensor_id is not None:
            if asset_type != "sensor":
                err("U402", path, "dct:sensorId는 센서 앵커에만 붙인다")
            elif sid_type != Sdf.ValueTypeNames.String:
                err("U402", path, f"dct:sensorId는 string이어야 한다 (현재 {sid_type})")
            elif not SENSOR_ID_RE.match(sensor_id):
                err("U402", path, f"센서 ID 형식이 올바르지 않다: '{sensor_id}' (예: H01-RK01-TEMP-IN)")
            elif kind == "scene":
                expected = sensor_id_from_path(path)  # 변환 규칙은 dct_ids.py 한 곳에만 있다
                if expected is not None and sensor_id != expected:
                    err("U402", path, f"센서 ID가 경로에서 만든 값과 다르다: '{sensor_id}' (기대 '{expected}')")
            if kind == "scene" and isinstance(sensor_id, str):
                if sensor_id in sensor_ids:
                    err("U403", path, f"센서 ID가 중복되었다: '{sensor_id}' (이미 {sensor_ids[sensor_id]})")
                else:
                    sensor_ids[sensor_id] = path
        if kind == "scene" and asset_type in SENSOR_REQUIRED_TYPES:
            equipment.append((path, asset_type))

        # U502 층 번호(dct:floor)는 1 이상의 정수 (Hall의 층, 건물 층 표시 모양)
        floor, _ = _get_str(prim, "dct:floor")
        if floor is not None and (isinstance(floor, bool) or not isinstance(floor, int) or floor < 1):
            err("U502", path, f"dct:floor는 1 이상의 정수여야 한다 (현재 {floor!r})")

        # U501 구역 값
        zone, zone_type = _get_str(prim, "dct:zone")
        if zone is not None:
            if zone_type != Sdf.ValueTypeNames.Token:
                err("U501", path, f"dct:zone은 token이어야 한다 (현재 {zone_type})")
            elif zone not in ZONES:
                err("U501", path, f"dct:zone 값이 올바르지 않다: '{zone}' (허용: {sorted(ZONES)})")

    for path, asset_type in equipment:  # U401: 장비는 센서 앵커를 하나 이상 가진다
        if anchors_of.get(path, 0) == 0:
            err("U401", path, f"{asset_type}에는 센서 앵커(Anchors/Sensor_*)가 하나 이상 필요하다")

    if kind == "scene" and not stage.GetPrimAtPath(f"/{ROOT_NAME}"):
        err("U103", "/", f"/{ROOT_NAME} prim이 없다")

    return findings


def validate_file(path: Path, kind: str = "scene") -> list[Finding]:
    try:
        stage = Usd.Stage.Open(str(path))
    except Exception as exc:  # USD가 파일을 못 열 때
        return [Finding("ERROR", "U000", str(path), f"파일을 열 수 없다: {exc}")]
    if stage is None:
        return [Finding("ERROR", "U000", str(path), "파일을 열 수 없다")]
    return validate_stage(stage, kind)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DC-Twin USD 규칙 검증")
    ap.add_argument("files", nargs="+", type=Path, help="검사할 USD 파일")
    ap.add_argument("--kind", choices=["scene", "asset"], default="scene", help="장면(scene) 또는 에셋(asset)")
    ap.add_argument("--strict", action="store_true", help="경고도 오류로 취급")
    args = ap.parse_args(argv)

    # 터미널이 아닌 곳(파이프, 파일, CI)으로 출력할 때 Windows 기본 인코딩(cp949)으로 한글이 깨지지 않게 한다.
    if not sys.stdout.isatty() and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    total_err = 0
    for f in args.files:
        findings = validate_file(f, args.kind)
        errors = [x for x in findings if x.level == "ERROR"]
        warns = [x for x in findings if x.level == "WARN"]
        print(f"== {f} ({args.kind})")
        for x in findings:
            print(x)
        print(f"   오류 {len(errors)}건, 경고 {len(warns)}건 -> {'통과' if not errors else '실패'}")
        total_err += len(errors) + (len(warns) if args.strict else 0)
    return 1 if total_err else 0


if __name__ == "__main__":
    sys.exit(main())
