"""배치 설정 파일(JSON)에서 홀 장면(USD)을 만든다. 장면은 손으로 고치지 않고 이 스크립트로 다시 만든다.

사용 (scripts/usd_tools 폴더에서):
    uv run --python 3.13 python build_scene.py ../../usd/scenes/hall01.config.json ../../usd/scenes/hall01.usda

만드는 것 (09 규격):
- 랙 N기: 에셋 참조, 줄 6개(Row01..), 번호는 홀 안에서 이어서 매김, 센서 앵커에 센서 ID 덮어쓰기
- CRAC 8기: 짧은 벽 양쪽, 뜨거운 통로 끝과 같은 줄
- 홀 외피(Shell): 바닥, 벽 4개, 천장, 걸레받이, 바닥 표시, 조명 패널. 재질과 UV가 있는 Mesh(hall_interior.py)
- 뜨거운 통로 격벽(Containment): 지붕과 줄 끝 옆면 패널(알루미늄 틀 + 반투명 유리)
- 바닥 급기구(Vents): 차가운 통로 바닥의 천공 타일
- 재질: /DC/Hall01/Looks (UsdPreviewSurface, 텍스처는 ../assets/textures/hall/)
- `--flat`을 주면 이전 방식(상자와 표시 색만)으로 만든다

좌표: 홀 안쪽이 x 0..W, y 0..L, 바닥 윗면이 z=0. 줄은 x축 방향, 통로는 y축 방향으로 쌓는다.
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

from pxr import Gf, Sdf, Usd, UsdGeom, Vt

import hall_interior as hi


@dataclass
class Layout:
    """설정에서 계산한 치수. 시뮬레이션이 같은 값을 쓰도록 `to_dict()`로 내보낼 수 있다."""

    width: float            # 홀 안쪽 x 길이
    length: float           # 홀 안쪽 y 길이
    height: float
    row_y0: list[float]     # 줄마다 y 시작
    row_front_plus_y: list[bool]  # 앞면이 +y를 향하는 줄
    hot_aisles: list[tuple[float, float]]   # (y 시작, y 끝)
    cold_aisles: list[tuple[float, float]]
    rack_x0: float
    rack_x1: float


def compute_layout(cfg: dict) -> Layout:
    r, rk = cfg["rows"], cfg["rack"]
    d, hot, cold = rk["depth"], r["hot_aisle"], r["cold_aisle"]
    pairs = r["count"] // 2
    y = 0.0
    row_y0, front_plus, hot_aisles, cold_aisles = [], [], [], []
    for _ in range(pairs):
        hot_aisles.append((y, y + hot)); y += hot
        row_y0.append(y); front_plus.append(True); y += d      # 앞면이 +y(차가운 통로 쪽)
        cold_aisles.append((y, y + cold)); y += cold
        row_y0.append(y); front_plus.append(False); y += d     # 앞면이 -y(차가운 통로 쪽)
    hot_aisles.append((y, y + hot)); y += hot
    crac_d = cfg["crac"]["depth"]
    x0 = crac_d + r["end_clearance"]
    x1 = x0 + r["racks_per_row"] * rk["width"]
    return Layout(
        width=x1 + r["end_clearance"] + crac_d, length=y, height=cfg["hall"]["ceiling_height"],
        row_y0=row_y0, row_front_plus_y=front_plus, hot_aisles=hot_aisles, cold_aisles=cold_aisles,
        rack_x0=x0, rack_x1=x1,
    )


def _xform(prim: UsdGeom.Xformable, translate=None, rotate_z=None, scale=None) -> None:
    if translate is not None:
        prim.AddTranslateOp().Set(Gf.Vec3d(*translate))
    if rotate_z is not None:
        prim.AddRotateZOp().Set(float(rotate_z))
    if scale is not None:
        prim.AddScaleOp().Set(Gf.Vec3f(*scale))


def add_box(stage: Usd.Stage, path: str, lo, hi, color, asset_type: str | None = None) -> None:
    """lo, hi는 (x, y, z) 최소/최대 모서리(cm). 한 변이 1인 Cube에 이동과 스케일을 건다."""
    cube = UsdGeom.Cube.Define(stage, path)
    cube.GetSizeAttr().Set(1.0)
    size = [hi[i] - lo[i] for i in range(3)]
    center = [(hi[i] + lo[i]) / 2 for i in range(3)]
    _xform(cube, translate=center, scale=size)
    cube.GetDisplayColorAttr().Set(Vt.Vec3fArray([Gf.Vec3f(*color)]))
    if asset_type:
        cube.GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set(asset_type)


def sensor_id(hall: int, code: str, number: int, metric: str) -> str:
    return f"H{hall:02d}-{code}{number:02d}-{metric.upper().replace('_', '-')}"


def override_sensors(stage: Usd.Stage, equip_path: str, hall: int, code: str, number: int, metrics: list[str]) -> None:
    for m in metrics:
        p = stage.OverridePrim(f"{equip_path}/Anchors/Sensor_{m.upper()}")
        p.CreateAttribute("dct:sensorId", Sdf.ValueTypeNames.String, custom=True).Set(sensor_id(hall, code, number, m))


def build(cfg: dict, out: Path, flat: bool = False) -> tuple[Usd.Stage, Layout]:
    lay = compute_layout(cfg)
    hall = cfg["hall"]["index"]
    col = cfg["colors"]
    hall_path = f"/DC/Hall{hall:02d}"
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Usd.Stage.CreateNew(str(out))  # 파일 위치에서 만들어야 에셋 상대 경로(../assets/...)가 풀린다
    UsdGeom.SetStageMetersPerUnit(stage, 0.01)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.Xform.Define(stage, "/DC")
    UsdGeom.Xform.Define(stage, hall_path)
    stage.SetDefaultPrim(stage.GetPrimAtPath("/DC"))

    # 랙
    rk = cfg["rack"]
    n_per = cfg["rows"]["racks_per_row"]
    rack_no = 0
    rack_prims: list[str] = []
    for ri, (y0, front_plus) in enumerate(zip(lay.row_y0, lay.row_front_plus_y), start=1):
        row_path = f"{hall_path}/Row{ri:02d}"
        UsdGeom.Xform.Define(stage, row_path)
        yc = y0 + rk["depth"] / 2
        for i in range(n_per):
            rack_no += 1
            p = f"{row_path}/Rack_{rack_no:02d}"
            xf = UsdGeom.Xform.Define(stage, p)
            xf.GetPrim().GetReferences().AddReference(rk["asset"])
            _xform(xf, translate=(lay.rack_x0 + rk["width"] * (i + 0.5), yc, 0.0), rotate_z=180.0 if front_plus else 0.0)
            override_sensors(stage, p, hall, "RK", rack_no, ["temp_in", "temp_out", "power"])
            rack_prims.append(p)

    # CRAC: 뜨거운 통로마다 양쪽 벽에 1기씩
    cr = cfg["crac"]
    cooling = f"{hall_path}/Cooling"
    UsdGeom.Xform.Define(stage, cooling)
    crac_no = 0
    for side, (x, rot) in enumerate([(cr["depth"] / 2, 90.0), (lay.width - cr["depth"] / 2, -90.0)]):
        for (ya, yb) in lay.hot_aisles:
            crac_no += 1
            p = f"{cooling}/CRAC_{crac_no:02d}"
            xf = UsdGeom.Xform.Define(stage, p)
            xf.GetPrim().GetReferences().AddReference(cr["asset"])
            _xform(xf, translate=(x, (ya + yb) / 2, 0.0), rotate_z=rot)  # 앞면(회수면)이 홀 안쪽을 향한다
            override_sensors(stage, p, hall, "CR", crac_no, ["supply_temp", "return_temp", "fan_speed"])

    W, L, H = lay.width, lay.length, lay.height
    tri: dict = {}
    if flat:
        # 이전 방식(상자 + 표시 색만). 재질, 텍스처가 필요 없을 때 쓴다.
        _build_flat(stage, hall_path, cfg, lay)
    else:
        # 재질은 /DC/Hall01/Looks. 외피, 격벽, 급기구는 재질과 UV가 있는 Mesh (hall_interior.py)
        mats = hi.define_materials(stage, f"{hall_path}/Looks", cfg.get("textures", "../assets/textures/hall"))
        shell = f"{hall_path}/Shell"
        UsdGeom.Xform.Define(stage, shell)
        tri["Shell"] = hi.build_shell(stage, shell, lay, cfg, mats)
        cont = f"{hall_path}/Containment"
        UsdGeom.Xform.Define(stage, cont)
        tri["Containment"] = hi.build_containment(stage, cont, lay, cfg, mats)
        vents = f"{hall_path}/Vents"
        UsdGeom.Xform.Define(stage, vents)
        tri["Vents"] = hi.build_vents(stage, vents, lay, cfg, mats)
    stage.GetPrimAtPath(hall_path).CreateAttribute("dct:hallSizeCm", Sdf.ValueTypeNames.Float3, custom=True).Set(Gf.Vec3f(W, L, H))
    # 이중 바닥과 바닥 아래 공간(raised_floor, 2026-11-11). 켜면 공조기가 바닥 아래로 찬 공기를 불어 넣고 급기구(천공 타일)로 올라온다.
    # 깊이와 타일 열린 비율은 근거 없는 가상 값이다(ADR-009에서 표준값을 찾지 못함). 시뮬레이션은 이 속성을 읽는다.
    rf = cfg.get("raised_floor", {})
    if rf.get("enabled"):
        hp = stage.GetPrimAtPath(hall_path)
        hp.CreateAttribute("dct:plenumDepthCm", Sdf.ValueTypeNames.Float, custom=True).Set(float(rf["plenum_depth"]))
        hp.CreateAttribute("dct:floorThicknessCm", Sdf.ValueTypeNames.Float, custom=True).Set(float(cfg["hall"]["floor_thickness"]))
        hp.CreateAttribute("dct:tileOpenRatio", Sdf.ValueTypeNames.Float, custom=True).Set(float(rf["tile_open_ratio"]))
        ft, wt, D = cfg["hall"]["floor_thickness"], cfg["hall"]["wall_thickness"], rf["plenum_depth"]
        # 바닥 아래 공간의 모양(보기용 상자. 계산은 위 속성과 홀 크기로 정한다)
        plen = UsdGeom.Cube.Define(stage, f"{hall_path}/Shell/Plenum")
        plen.CreateSizeAttr(1.0)
        _xform(plen, translate=(W / 2, L / 2, -ft - D / 2), scale=(W, L, D))
        plen.CreatePurposeAttr(UsdGeom.Tokens.guide)
        # 바닥 아래 장애물(2026-11-11, 사용자: "바닥 아래가 텅 빈 건 말이 안 된다"). 실제 시설에는 받침 기둥, 케이블 트레이, 배관,
        # 막지 않은 케이블 구멍이 있다. 모양은 가상 배치이며, 시뮬레이션은 dct:underfloorKind가 붙은 상자를 읽는다.
        ob = rf.get("obstructions", {})
        if ob.get("pedestal_pitch"):
            hp.CreateAttribute("dct:pedestalPitchCm", Sdf.ValueTypeNames.Float, custom=True).Set(float(ob["pedestal_pitch"]))
            hp.CreateAttribute("dct:pedestalWidthCm", Sdf.ValueTypeNames.Float, custom=True).Set(float(ob.get("pedestal_width", 3)))
        uf = f"{hall_path}/Shell/Underfloor"
        boxes = []
        rk = cfg["rack"]
        z_slab = -ft - D  # 바닥 아래 공간의 바닥(슬래브 윗면)
        if ob.get("cable_trays"):
            t = ob["cable_trays"]  # 랙 줄마다 랙 아래로 줄 방향(x)을 따라
            for i, y0 in enumerate(lay.row_y0):
                yc = y0 + rk["depth"] / 2
                boxes.append(("cable_tray", f"CableTray_{i + 1:02d}", (lay.rack_x0 - 50, yc - t["width"] / 2, z_slab + t["z"]), (lay.rack_x1 + 50, yc + t["width"] / 2, z_slab + t["z"] + t["height"])))
        if ob.get("pipes"):
            p_ = ob["pipes"]  # 공조기 앞(토출구 쪽)을 따라 홀 길이 방향(y)으로 냉수 배관 한 쌍씩
            for side, xc in enumerate((cfg["crac"]["depth"] + p_["offset"], W - cfg["crac"]["depth"] - p_["offset"])):
                boxes.append(("pipe", f"Pipe_{side + 1:02d}", (xc - p_["size"] / 2, 20, z_slab), (xc + p_["size"] / 2, L - 20, z_slab + p_["size"])))
        if ob.get("cutouts"):
            c_ = ob["cutouts"]  # 랙 뒤(뜨거운 통로 쪽) 바닥판에 막지 않은 케이블 구멍
            n = 0
            for y0, plus in zip(lay.row_y0, lay.row_front_plus_y):
                yb = y0 if plus else y0 + rk["depth"]  # 뒷면
                ya, yb2 = (yb - c_["depth"], yb) if plus else (yb, yb + c_["depth"])
                for k in range(cfg["rows"]["racks_per_row"]):
                    n += 1
                    xc = lay.rack_x0 + rk["width"] * (k + 0.5)
                    boxes.append(("cutout", f"Cutout_{n:02d}", (xc - c_["width"] / 2, ya, -ft), (xc + c_["width"] / 2, yb2, 0)))
        for kind, name, b_lo, b_hi in boxes:
            c = UsdGeom.Cube.Define(stage, f"{uf}/{name}")
            c.CreateSizeAttr(1.0)
            _xform(c, translate=tuple((a + b) / 2 for a, b in zip(b_lo, b_hi)), scale=tuple(b - a for a, b in zip(b_lo, b_hi)))
            c.CreatePurposeAttr(UsdGeom.Tokens.guide)
            c.GetPrim().CreateAttribute("dct:underfloorKind", Sdf.ValueTypeNames.Token, custom=True).Set(kind)
    build.last_triangles = tri
    return stage, lay


def _build_flat(stage: Usd.Stage, hall_path: str, cfg: dict, lay: Layout) -> None:
    """이전 방식: 상자(Cube)와 displayColor만. `--flat` 옵션."""
    col, cr, rk = cfg["colors"], cfg["crac"], cfg["rack"]
    shell = f"{hall_path}/Shell"
    UsdGeom.Xform.Define(stage, shell)
    ft, wt, W, L, H = cfg["hall"]["floor_thickness"], cfg["hall"]["wall_thickness"], lay.width, lay.length, lay.height
    add_box(stage, f"{shell}/Floor", (-wt, -wt, -ft), (W + wt, L + wt, 0), col["floor"], "shell")
    add_box(stage, f"{shell}/Wall_West", (-wt, -wt, 0), (0, L + wt, H), col["wall"], "shell")
    add_box(stage, f"{shell}/Wall_East", (W, -wt, 0), (W + wt, L + wt, H), col["wall"], "shell")
    add_box(stage, f"{shell}/Wall_South", (0, -wt, 0), (W, 0, H), col["wall"], "shell")
    add_box(stage, f"{shell}/Wall_North", (0, L, 0), (W, L + wt, H), col["wall"], "shell")
    add_box(stage, f"{shell}/Ceiling", (-wt, -wt, H), (W + wt, L + wt, H + wt), col["ceiling"], "shell")
    ct = cfg["containment"]
    t, rz = ct["panel_thickness"], ct["roof_z"]
    cont = f"{hall_path}/Containment"
    UsdGeom.Xform.Define(stage, cont)
    xa, xb = cr["depth"], W - cr["depth"]
    for k, (ya, yb) in enumerate(lay.hot_aisles, start=1):
        add_box(stage, f"{cont}/HotAisle_{k:02d}_Roof", (xa, ya, rz), (xb, yb, rz + t), col["containment"], "containment")
        for edge, outward in ((ya, -1), (yb, 1)):
            if (k == 1 and outward == -1) or (k == len(lay.hot_aisles) and outward == 1):
                continue
            lo_y, hi_y = (edge - t, edge) if outward == -1 else (edge, edge + t)
            for tag, (x0, x1) in (("W", (xa, lay.rack_x0)), ("E", (lay.rack_x1, xb))):
                add_box(stage, f"{cont}/HotAisle_{k:02d}_Side{'N' if outward == 1 else 'S'}_{tag}", (x0, lo_y, 0), (x1, hi_y, rz), col["containment"], "containment")
    vt = cfg["vent"]
    vents = f"{hall_path}/Vents"
    UsdGeom.Xform.Define(stage, vents)
    vn = 0
    for (ya, yb) in lay.cold_aisles:
        yc = (ya + yb) / 2
        for i in range(cfg["rows"]["racks_per_row"]):
            vn += 1
            xc = lay.rack_x0 + rk["width"] * (i + 0.5)
            add_box(stage, f"{vents}/Vent_{vn:02d}", (xc - vt["width"] / 2, yc - vt["depth"] / 2, 0), (xc + vt["width"] / 2, yc + vt["depth"] / 2, vt["thickness"]), col["vent"], "vent")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="배치 설정에서 홀 장면 USD 만들기")
    ap.add_argument("config", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--flat", action="store_true", help="재질, 텍스처 없이 상자와 표시 색만(이전 방식)")
    args = ap.parse_args(argv)
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    stage, lay = build(cfg, args.out, flat=args.flat)
    stage.GetRootLayer().Save()
    racks = cfg["rows"]["count"] * cfg["rows"]["racks_per_row"]
    print(f"홀 {lay.width / 100:.1f} x {lay.length / 100:.1f} x {lay.height / 100:.1f} m, 랙 {racks}기, CRAC {cfg['crac']['per_side'] * 2}기 -> {args.out}")
    for part, n in getattr(build, "last_triangles", {}).items():
        print(f"  {part}: 삼각형 {sum(n.values()) if isinstance(n, dict) else n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
