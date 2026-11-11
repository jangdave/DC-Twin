"""R5 실증: USD 장면 위에서 Warp로 열 시뮬레이션을 하고, 센서 앵커 위치에서 가상 센서 값을 읽는다.

- 교육·시각화용 간단한 모델이다. 공기 흐름은 영역별로 정해 둔 값이며(이류-확산), 실제 열역학 해석이 아니다.
- 흐름: USD 장면 생성(또는 읽기) → 형상과 앵커를 USD에서 읽음 → Warp 시뮬레이션 → 가상 센서 값 → NanoVDB 저장

사용 (이 폴더에서): uv run --python 3.13 python thermal_poc.py [--duration 240] [--fail-time 60]
"""
from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np
import warp as wp
from PIL import Image, ImageDraw
from pxr import Gf, Sdf, Usd, UsdGeom

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

# ---- 장면 규격 (cm, Z-up). 09 USD 규격의 이름과 속성 규칙을 따른다 ----
HALL_CM = (800.0, 600.0, 350.0)
RACK_SIZE_CM = (60.0, 100.0, 200.0)
CRAC_SIZE_CM = (100.0, 100.0, 200.0)

# ---- 시뮬레이션 매개변수 (모두 "그럴듯하게 보이게" 정한 값이며 측정값이 아니다) ----
DX = 0.10          # 격자 간격 (m)
DT = 0.02          # 시간 간격 (s)
K_DIFF = 0.02      # 확산 계수 (m^2/s, 난류 혼합을 흉내 낸 값)
K_HEAT = 1.6       # 랙 전력 1 kW당 가열률 (K/s)
T_SUPPLY = 18.0    # CRAC 공급 온도 (degC)
T_INIT = 22.0      # 초기 공기 온도
V_RACK = 0.8       # 랙 안 공기 속도 (m/s)
V_AISLE = 0.8      # 냉기 통로 공급 흐름 (m/s)
V_UP = 0.4         # 열기 통로 상승 흐름 (m/s)
V_CEIL = 0.4       # 천장층 흐름 (m/s)
V_DESCEND = 0.10   # 냉기 통로 위쪽 하강 흐름 (m/s)
SUPPLY_RATE = 6.0  # 공급 영역 냉각 속도 (1/s)
RETURN_RATE = 1.5  # 회수 영역 냉각 속도 (1/s)

REGION_NONE, REGION_RACK_A, REGION_RACK_B, REGION_COLD, REGION_HOT, REGION_CEIL = 0, 1, 2, 3, 4, 5


# =====================================================================
# 1) USD 장면 만들기
# =====================================================================
def sensor_id(hall_no: int, equipment_name: str, metric: str) -> str:
    """09 USD 규격 5장의 규칙: H + 홀 번호 + - + 장비 코드 + 번호 + - + 측정 종류(대문자, _는 -)."""
    code = {"Rack": "RK", "CRAC": "CR", "PDU": "PD"}[equipment_name.split("_")[0]]
    num = equipment_name.split("_")[1]
    return f"H{hall_no:02d}-{code}{num}-{metric.upper().replace('_', '-')}"


def _equipment(stage, path, size_cm, center_xy, asset_type):
    """장비는 스케일 없는 Xform(원점 = 바닥 중앙)이고, 모양은 자식 메시(Geo)다. (09 USD 규격 2장)
    앵커를 스케일이 걸린 prim 아래에 두면 월드 위치가 틀어지므로 이 구조를 지킨다."""
    xf = UsdGeom.Xform.Define(stage, path)
    UsdGeom.Xformable(xf).AddTranslateOp().Set(Gf.Vec3d(center_xy[0], center_xy[1], 0.0))
    xf.GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set(asset_type)
    geo = UsdGeom.Cube.Define(stage, f"{path}/Geo")
    geo.GetSizeAttr().Set(1.0)
    g = UsdGeom.Xformable(geo)
    g.AddTranslateOp().Set(Gf.Vec3d(0.0, 0.0, size_cm[2] / 2))
    g.AddScaleOp().Set(Gf.Vec3f(*size_cm))
    return xf.GetPrim()


def _anchor(stage, path, pos, metric, unit):
    x = UsdGeom.Xform.Define(stage, path)
    UsdGeom.Xformable(x).AddTranslateOp().Set(Gf.Vec3d(*pos))
    p = x.GetPrim()
    p.CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set("sensor")
    p.CreateAttribute("dct:metric", Sdf.ValueTypeNames.Token, custom=True).Set(metric)
    p.CreateAttribute("dct:unit", Sdf.ValueTypeNames.String, custom=True).Set(unit)
    return p


def build_scene(path: Path) -> None:
    """랙 2줄 x 5기, 마주 보는 냉기 통로(폭 120cm), 양 끝에 CRAC 1기씩."""
    stage = Usd.Stage.CreateNew(str(path))
    UsdGeom.SetStageMetersPerUnit(stage, 0.01)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    root = UsdGeom.Xform.Define(stage, "/DC")
    stage.SetDefaultPrim(root.GetPrim())
    hall = UsdGeom.Xform.Define(stage, "/DC/Hall01")
    hall.GetPrim().CreateAttribute("dct:floor", Sdf.ValueTypeNames.Int, custom=True).Set(3)

    rw, rd, rh = RACK_SIZE_CM
    xs = [250 + 60 * i + 30 for i in range(5)]  # 랙 중심 x
    n = 1
    for row_idx, (row_name, y_center, front_sign) in enumerate([("Row01", 190.0, +1), ("Row02", 410.0, -1)], start=1):
        UsdGeom.Xform.Define(stage, f"/DC/Hall01/{row_name}")
        for x in xs:
            name = f"Rack_{n:02d}"
            rp = f"/DC/Hall01/{row_name}/{name}"
            _equipment(stage, rp, RACK_SIZE_CM, (x, y_center), "rack")
            # 센서 앵커(장비 기준 로컬 좌표): 앞면(냉기 통로 쪽) 입구, 뒷면 출구. 앵커는 랙 바깥 10cm
            UsdGeom.Xform.Define(stage, f"{rp}/Anchors")
            _anchor(stage, f"{rp}/Anchors/Sensor_TEMP_IN", (0.0, front_sign * (rd / 2 + 10), 120.0), "temp_in", "degC")
            _anchor(stage, f"{rp}/Anchors/Sensor_TEMP_OUT", (0.0, -front_sign * (rd / 2 + 10), 120.0), "temp_out", "degC")
            n += 1

    UsdGeom.Xform.Define(stage, "/DC/Hall01/Cooling")
    cw, cd, ch = CRAC_SIZE_CM
    for i, x in enumerate([60.0, 740.0], start=1):  # 서쪽, 동쪽 끝
        name = f"CRAC_{i:02d}"
        cp = f"/DC/Hall01/Cooling/{name}"
        _equipment(stage, cp, CRAC_SIZE_CM, (x, 300.0), "crac")
        face_dx = (cw / 2 + 10) * (1 if i == 1 else -1)
        UsdGeom.Xform.Define(stage, f"{cp}/Anchors")
        _anchor(stage, f"{cp}/Anchors/Sensor_SUPPLY_TEMP", (face_dx, 0.0, 30.0), "supply_temp", "degC")
        _anchor(stage, f"{cp}/Anchors/Sensor_RETURN_TEMP", (0.0, 0.0, ch + 20.0), "return_temp", "degC")
    stage.GetRootLayer().Save()


# =====================================================================
# 2) USD에서 형상과 앵커 읽기
# =====================================================================
def read_scene(path: Path) -> dict:
    stage = Usd.Stage.Open(str(path))
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    racks, cracs, anchors = [], [], []
    for prim in stage.Traverse():
        at = prim.GetAttribute("dct:assetType")
        if not at:
            continue
        kind = at.Get()
        if kind in ("rack", "crac"):
            r = cache.ComputeWorldBound(prim).ComputeAlignedRange()
            item = {"name": prim.GetName(), "path": str(prim.GetPath()), "min": tuple(r.GetMin()), "max": tuple(r.GetMax())}
            (racks if kind == "rack" else cracs).append(item)
        elif kind == "sensor":
            m = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default()).ExtractTranslation()
            equip = prim.GetParent().GetParent()
            anchors.append(
                {
                    "path": str(prim.GetPath()),
                    "equipment": equip.GetName(),
                    "metric": prim.GetAttribute("dct:metric").Get(),
                    "unit": prim.GetAttribute("dct:unit").Get(),
                    "pos_cm": (m[0], m[1], m[2]),
                }
            )
    return {"racks": sorted(racks, key=lambda d: d["name"]), "cracs": sorted(cracs, key=lambda d: d["name"]), "anchors": anchors}


# =====================================================================
# 3) Warp 시뮬레이션
# =====================================================================
@wp.func
def sample_T(T: wp.array3d(dtype=float), p: wp.vec3, nx: int, ny: int, nz: int):
    """격자 좌표(셀 중심이 정수)에서 세 선형 보간. 경계 밖은 가장자리 값으로 고정."""
    x = wp.clamp(p[0], 0.0, float(nx - 1))
    y = wp.clamp(p[1], 0.0, float(ny - 1))
    z = wp.clamp(p[2], 0.0, float(nz - 1))
    i0 = int(wp.floor(x))
    j0 = int(wp.floor(y))
    k0 = int(wp.floor(z))
    i1 = wp.min(i0 + 1, nx - 1)
    j1 = wp.min(j0 + 1, ny - 1)
    k1 = wp.min(k0 + 1, nz - 1)
    fx = x - float(i0)
    fy = y - float(j0)
    fz = z - float(k0)
    c00 = T[i0, j0, k0] * (1.0 - fx) + T[i1, j0, k0] * fx
    c10 = T[i0, j1, k0] * (1.0 - fx) + T[i1, j1, k0] * fx
    c01 = T[i0, j0, k1] * (1.0 - fx) + T[i1, j0, k1] * fx
    c11 = T[i0, j1, k1] * (1.0 - fx) + T[i1, j1, k1] * fx
    c0 = c00 * (1.0 - fy) + c10 * fy
    c1 = c01 * (1.0 - fy) + c11 * fy
    return c0 * (1.0 - fz) + c1 * fz


@wp.kernel
def step_kernel(
    T: wp.array3d(dtype=float),
    T_out: wp.array3d(dtype=float),
    region: wp.array3d(dtype=int),
    aux_dir: wp.array3d(dtype=float),
    aux_idx: wp.array3d(dtype=int),
    rack_id: wp.array3d(dtype=int),
    supply_id: wp.array3d(dtype=int),
    return_id: wp.array3d(dtype=int),
    rack_power: wp.array(dtype=float),
    fan: wp.array(dtype=float),
    dt: float,
    dx: float,
    k_diff: float,
    k_heat: float,
    t_supply: float,
    v_rack: float,
    v_aisle: float,
    v_up: float,
    v_ceil: float,
    v_descend: float,
    supply_rate: float,
    return_rate: float,
):
    i, j, k = wp.tid()
    nx = T.shape[0]
    ny = T.shape[1]
    nz = T.shape[2]

    # 1) 이 칸의 정해 둔 공기 흐름 (m/s)
    r = region[i, j, k]
    u = wp.vec3(0.0, 0.0, 0.0)
    if r == 1:  # 랙 A: 냉기 통로(+y)에서 뒤(-y)로
        u = wp.vec3(0.0, -v_rack, 0.0)
    elif r == 2:  # 랙 B: 냉기 통로(-y)에서 뒤(+y)로
        u = wp.vec3(0.0, v_rack, 0.0)
    elif r == 3:  # 냉기 통로: CRAC에서 멀어지는 x 방향. 위쪽(천장 근처)은 아래로 내려옴
        f = fan[aux_idx[i, j, k]]
        u = wp.vec3(aux_dir[i, j, k] * v_aisle * f, 0.0, -v_descend)
    elif r == 4:  # 열기 통로: 위로
        u = wp.vec3(0.0, 0.0, v_up)
    elif r == 5:  # 천장층: 냉기 통로 중심(y)과 가까운 CRAC(x) 쪽으로
        u = wp.vec3(aux_dir[i, j, k] * v_ceil, 0.0, 0.0)
        yc = 0.5 * float(ny - 1)
        if float(j) > yc:
            u = wp.vec3(u[0], -v_ceil * 0.5, 0.0)
        else:
            u = wp.vec3(u[0], v_ceil * 0.5, 0.0)

    # 2) 이류: 속도만큼 거슬러 올라간 위치의 온도 (반 라그랑지안, 항상 안정)
    p = wp.vec3(float(i), float(j), float(k)) - u * (dt / dx)
    t_adv = sample_T(T, p, nx, ny, nz)

    # 3) 확산 (이웃 6칸, 경계는 가장자리 값 복사)
    c = T[i, j, k]
    xm = T[wp.max(i - 1, 0), j, k]
    xp = T[wp.min(i + 1, nx - 1), j, k]
    ym = T[i, wp.max(j - 1, 0), k]
    yp = T[i, wp.min(j + 1, ny - 1), k]
    zm = T[i, j, wp.max(k - 1, 0)]
    zp = T[i, j, wp.min(k + 1, nz - 1)]
    lap = (xm + xp + ym + yp + zm + zp - 6.0 * c) / (dx * dx)
    t_new = t_adv + k_diff * lap * dt

    # 4) 열원: 랙 전력에 비례
    rid = rack_id[i, j, k]
    if rid >= 0:
        t_new = t_new + k_heat * rack_power[rid] * dt

    # 5) 냉각: CRAC 공급 영역과 회수 영역(팬 속도에 비례)
    sid = supply_id[i, j, k]
    if sid >= 0:
        t_new = t_new + (t_supply - t_new) * wp.min(1.0, supply_rate * fan[sid] * dt)
    rtn = return_id[i, j, k]
    if rtn >= 0:
        t_new = t_new + (t_supply - t_new) * wp.min(1.0, return_rate * fan[rtn] * dt)

    T_out[i, j, k] = t_new


@wp.kernel
def sample_points(T: wp.array3d(dtype=float), pts: wp.array(dtype=wp.vec3), out: wp.array(dtype=float)):
    n = wp.tid()
    out[n] = sample_T(T, pts[n], T.shape[0], T.shape[1], T.shape[2])


class Hall:
    """USD에서 읽은 형상으로 격자를 만들고 시뮬레이션을 돌린다."""

    def __init__(self, scene: dict, device: str = "cuda:0"):
        self.device = device
        self.scene = scene
        self.nx, self.ny, self.nz = (int(round(c / 100.0 / DX)) for c in HALL_CM)
        shape = (self.nx, self.ny, self.nz)
        region = np.zeros(shape, dtype=np.int32)
        aux_dir = np.zeros(shape, dtype=np.float32)
        aux_idx = np.zeros(shape, dtype=np.int32)
        rack_id = np.full(shape, -1, dtype=np.int32)
        supply_id = np.full(shape, -1, dtype=np.int32)
        return_id = np.full(shape, -1, dtype=np.int32)

        def cells(lo, hi):  # cm 범위 -> 셀 인덱스 범위
            return int(round(lo / 100.0 / DX)), int(round(hi / 100.0 / DX))

        cold_y = cells(240.0, 360.0)
        # 랙: 형상을 USD에서 읽는다
        for idx, r in enumerate(scene["racks"]):
            (x0, y0, z0), (x1, y1, z1) = r["min"], r["max"]
            xs, xe = cells(x0, x1)
            ys, ye = cells(y0, y1)
            zs, ze = cells(z0, z1)
            rack_id[xs:xe, ys:ye, zs:ze] = idx
            region[xs:xe, ys:ye, zs:ze] = REGION_RACK_A if (y0 + y1) / 2 < 300.0 else REGION_RACK_B
        # CRAC: 공급 영역(통로 쪽 앞, 바닥 근처), 회수 영역(위쪽)
        self.crac_x = []
        for idx, c in enumerate(scene["cracs"]):
            (x0, y0, z0), (x1, y1, z1) = c["min"], c["max"]
            cx = (x0 + x1) / 2
            self.crac_x.append(cx)
            west = cx < HALL_CM[0] / 2
            fx0, fx1 = (x1, x1 + 40.0) if west else (x0 - 40.0, x0)
            xs, xe = cells(fx0, fx1)
            ys, ye = cells(y0, y1)
            zs, ze = cells(0.0, 80.0)
            supply_id[xs:xe, ys:ye, zs:ze] = idx
            xs, xe = cells(x0, x1)
            zs, ze = cells(z1, z1 + 60.0)
            return_id[xs:xe, ys:ye, zs:ze] = idx
        # 영역별 흐름 지정 (랙이 차지한 칸은 유지)
        ys0, ys1 = cold_y
        zc_top = int(round(2.0 / DX))
        z_ceil = int(round(2.5 / DX))
        for i in range(self.nx):
            x_cm = (i + 0.5) * DX * 100.0
            nearest = int(np.argmin([abs(x_cm - cx) for cx in self.crac_x]))
            direction = 1.0 if x_cm >= self.crac_x[nearest] else -1.0  # CRAC에서 멀어지는 방향
            for j in range(self.ny):
                for k in range(self.nz):
                    if region[i, j, k] in (REGION_RACK_A, REGION_RACK_B):
                        continue
                    y_cm = (j + 0.5) * DX * 100.0
                    if k >= z_ceil:
                        region[i, j, k] = REGION_CEIL
                        aux_dir[i, j, k] = -direction  # 천장층은 CRAC 쪽으로
                    elif 240.0 <= y_cm <= 360.0 and k < zc_top:
                        region[i, j, k] = REGION_COLD
                        aux_dir[i, j, k] = direction
                        aux_idx[i, j, k] = nearest
                    elif 240.0 <= y_cm <= 360.0:
                        region[i, j, k] = REGION_COLD  # 통로 위쪽: 하강 흐름만 (속도는 f에 비례하지 않음)
                        aux_dir[i, j, k] = 0.0
                        aux_idx[i, j, k] = nearest
                    elif (y_cm < 140.0 or y_cm > 460.0) and k < z_ceil:
                        region[i, j, k] = REGION_HOT

        d = device
        self.region = wp.array(region, dtype=int, device=d)
        self.aux_dir = wp.array(aux_dir, dtype=float, device=d)
        self.aux_idx = wp.array(aux_idx, dtype=int, device=d)
        self.rack_id = wp.array(rack_id, dtype=int, device=d)
        self.supply_id = wp.array(supply_id, dtype=int, device=d)
        self.return_id = wp.array(return_id, dtype=int, device=d)
        self.T = wp.array(np.full(shape, T_INIT, dtype=np.float32), dtype=float, device=d)
        self.T2 = wp.zeros(shape, dtype=float, device=d)
        self.rack_power = wp.array(np.full(len(scene["racks"]), 6.0, dtype=np.float32), dtype=float, device=d)
        self.fan = wp.array(np.ones(len(scene["cracs"]), dtype=np.float32), dtype=float, device=d)
        self.n_cells = self.nx * self.ny * self.nz

    def set_fan(self, idx: int, value: float):
        f = self.fan.numpy()
        f[idx] = value
        self.fan = wp.array(f, dtype=float, device=self.device)

    def set_power(self, powers: np.ndarray):
        self.rack_power = wp.array(powers.astype(np.float32), dtype=float, device=self.device)

    def step(self):
        wp.launch(
            step_kernel,
            dim=(self.nx, self.ny, self.nz),
            inputs=[
                self.T, self.T2, self.region, self.aux_dir, self.aux_idx, self.rack_id, self.supply_id, self.return_id,
                self.rack_power, self.fan, DT, DX, K_DIFF, K_HEAT, T_SUPPLY, V_RACK, V_AISLE, V_UP, V_CEIL, V_DESCEND,
                SUPPLY_RATE, RETURN_RATE,
            ],
            device=self.device,
        )
        self.T, self.T2 = self.T2, self.T

    def read_sensors(self, anchors: list[dict]) -> np.ndarray:
        """앵커 위치(cm)를 격자 좌표로 바꿔 온도를 보간해 읽는다."""
        pts = np.array(
            [[a["pos_cm"][0] / 100.0 / DX - 0.5, a["pos_cm"][1] / 100.0 / DX - 0.5, a["pos_cm"][2] / 100.0 / DX - 0.5] for a in anchors],
            dtype=np.float32,
        )
        wp_pts = wp.array(pts, dtype=wp.vec3, device=self.device)
        out = wp.zeros(len(anchors), dtype=float, device=self.device)
        wp.launch(sample_points, dim=len(anchors), inputs=[self.T, wp_pts, out], device=self.device)
        return out.numpy()


# =====================================================================
# 4) 시각화와 저장
# =====================================================================
def colorize(t: np.ndarray, lo: float = 16.0, hi: float = 40.0) -> np.ndarray:
    """온도를 파랑 → 하늘 → 초록 → 노랑 → 빨강 색으로 바꾼다."""
    x = np.clip((t - lo) / (hi - lo), 0, 1)
    stops = np.array([[0.0, 0, 0, 160], [0.25, 0, 160, 220], [0.5, 40, 200, 80], [0.75, 250, 220, 30], [1.0, 220, 20, 20]])
    rgb = np.stack([np.interp(x, stops[:, 0], stops[:, c]) for c in (1, 2, 3)], axis=-1)
    return rgb.astype(np.uint8)


def save_slice(hall: Hall, path: Path, z_cm: float, label: str, scale: int = 8):
    T = hall.T.numpy()
    k = int(round(z_cm / 100.0 / DX - 0.5))
    img = colorize(T[:, :, k].T)  # (ny, nx, 3)
    im = Image.fromarray(img[::-1]).resize((hall.nx * scale, hall.ny * scale), Image.NEAREST)
    d = ImageDraw.Draw(im)
    for r in hall.scene["racks"] + hall.scene["cracs"]:
        (x0, y0, _), (x1, y1, _) = r["min"], r["max"]
        px = lambda x: x / 100.0 / DX * scale
        py = lambda y: im.height - y / 100.0 / DX * scale
        d.rectangle([px(x0), py(y1), px(x1), py(y0)], outline=(255, 255, 255), width=2)
    d.text((6, 6), f"{label}  z={z_cm:.0f}cm  ({T.min():.1f}~{T.max():.1f} degC)", fill=(255, 255, 255))
    im.save(path)


def save_nvdb(hall: Hall, path: Path) -> dict:
    """온도장을 NanoVDB로 저장하고 다시 읽어 값이 같은지 확인한다."""
    T = hall.T.numpy().astype(np.float32)
    vol = wp.Volume.load_from_numpy(T, min_world=(0.0, 0.0, 0.0), voxel_size=DX, bg_value=T_INIT, device=hall.device)
    vol.save_to_nvdb(str(path))
    with open(path, "rb") as f:  # load_from_nvdb는 경로가 아니라 파일 객체나 바이트를 받는다
        back = wp.Volume.load_from_nvdb(f, device=hall.device)
    return {
        "path": path.name,
        "size_kib": round(path.stat().st_size / 1024, 1),
        "voxels_active": int(back.get_voxel_count()),
        "voxel_size_m": back.get_voxel_size(),
    }


# =====================================================================
# 5) 실행
# =====================================================================
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=float, default=240.0, help="시뮬레이션 시간(초)")
    ap.add_argument("--fail-time", type=float, default=60.0, help="CRAC_02 팬이 멈추는 시각(초)")
    ap.add_argument("--fail-crac", type=int, default=2)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    wp.config.quiet = True
    wp.init()
    rng = np.random.default_rng(args.seed)

    scene_path = OUT / "poc_hall.usda"
    build_scene(scene_path)
    scene = read_scene(scene_path)
    hall = Hall(scene)

    # 센서 정의: 앵커마다 센서 ID를 규칙대로 계산
    sensors = []
    for a in scene["anchors"]:
        a["sensor_id"] = sensor_id(1, a["equipment"], a["metric"])
        sensors.append(a)
    temp_anchors = [a for a in sensors if a["unit"] == "degC"]

    base_power = 5.0 + 2.0 * rng.random(len(scene["racks"]))
    steps_per_s = int(round(1.0 / DT))
    n_seconds = int(args.duration)
    rows = []
    slices_at = {int(args.fail_time) - 1: "fan 정상", int(args.fail_time) + 59: "고장 후 60초", n_seconds - 1: "고장 후 끝"}
    t_cross = {}
    t_wall0 = time.perf_counter()
    for s in range(n_seconds):
        if s == int(args.fail_time):
            hall.set_fan(args.fail_crac - 1, 0.0)
        # 전력은 천천히 흔들린다 (사인 + 잡음)
        hall.set_power(base_power * (1.0 + 0.05 * np.sin(2 * np.pi * s / 120.0)) + 0.1 * rng.standard_normal(len(base_power)))
        for _ in range(steps_per_s):
            hall.step()
        vals = hall.read_sensors(temp_anchors)
        for a, v in zip(temp_anchors, vals):
            noisy = float(v + 0.05 * rng.standard_normal())
            rows.append((s + 1, a["sensor_id"], a["metric"], round(noisy, 3)))
            if a["metric"] == "temp_in" and noisy >= 27.0 and a["sensor_id"] not in t_cross:
                t_cross[a["sensor_id"]] = s + 1
        if s in slices_at:
            save_slice(hall, OUT / f"thermal_slice_t{s + 1:03d}.png", 120.0, f"t={s + 1}s {slices_at[s]}")
    wp.synchronize_device(hall.device)
    wall = time.perf_counter() - t_wall0

    with open(OUT / "thermal_sensors.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sim_time_s", "sensor_id", "metric", "value_degC"])
        w.writerows(rows)

    nvdb = save_nvdb(hall, OUT / "thermal_final.nvdb")

    # 요약: 고장 전후 입구 온도
    def mean_at(window, metric="temp_in"):
        lo, hi = window
        v = [r[3] for r in rows if r[2] == metric and lo <= r[0] <= hi]
        return round(float(np.mean(v)), 2)

    by_rack = {}
    for r in rows:
        if r[2] == "temp_in":
            by_rack.setdefault(r[1], []).append((r[0], r[3]))
    per_rack_final = {k: round(float(np.mean([v for t, v in lst if t > n_seconds - 10])), 2) for k, lst in by_rack.items()}
    summary = {
        "params": {"dx_m": DX, "dt_s": DT, "k_diff": K_DIFF, "k_heat_K_per_s_per_kW": K_HEAT, "t_supply": T_SUPPLY,
                   "v_rack": V_RACK, "v_aisle": V_AISLE, "v_up": V_UP, "v_ceil": V_CEIL, "v_descend": V_DESCEND},
        "grid": {"nx": hall.nx, "ny": hall.ny, "nz": hall.nz, "cells": hall.n_cells},
        "scenario": {"duration_s": n_seconds, "fail_crac": args.fail_crac, "fail_time_s": args.fail_time},
        "performance": {
            "sim_seconds": n_seconds,
            "steps": n_seconds * steps_per_s,
            "wall_seconds": round(wall, 2),
            "realtime_factor": round(n_seconds / wall, 1),
            "sensor_reads": len(rows),
        },
        "temp_in_mean_degC": {
            "before_failure_30_59s": mean_at((30, int(args.fail_time) - 1)),
            "after_failure_end_10s": mean_at((n_seconds - 9, n_seconds)),
        },
        "temp_in_final_by_rack": per_rack_final,
        "seconds_to_cross_27C_after_start": t_cross,
        "nvdb": nvdb,
        "sensor_ids_from_usd": [a["sensor_id"] for a in sensors][:6] + ["..."],
        "sensor_count_from_usd": len(sensors),
    }
    (OUT / "thermal_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("grid", "performance", "temp_in_mean_degC", "nvdb", "sensor_count_from_usd")}, indent=2, ensure_ascii=False))
    print("27도 도달 센서 수:", len(t_cross))


if __name__ == "__main__":
    main()
