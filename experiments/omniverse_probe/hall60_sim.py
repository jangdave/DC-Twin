"""랙 60기 홀 장면(USD)을 읽어서 열 시뮬레이션을 돌린다. 시각화 목적이며 공학적 CFD가 아니다.

- 입력: usd/scenes/hall01.usda. 랙, CRAC, 급기구, 격벽의 위치와 앞면 방향을 장면에서 읽는다(코드에 배치를 적지 않는다).
  Unreal에서 랙 배치를 바꿔 장면을 다시 만들면 이 스크립트가 같은 방식으로 새 배치를 읽는다.
- 공기 흐름: 질량 보존 퍼텐셜 흐름(∇²φ = s, u = ∇φ). 급기구와 랙 뒷면은 내보내는 곳, 랙 앞면과 CRAC 회수면은 빨아들이는 곳.
  점성, 난류, 부력이 없는 단순 모델이라 순환 구조를 보여 주는 용도다.
- 온도: Warp로 이류(반 라그랑지안, 기본은 MacCormack 오차 보정) + 확산 + 랙 발열. 급기구 온도는 공급 온도로 고정한다.
- 새는 공기: 용량을 넘는 뜨거운 공기는 격벽 지붕 틈 아래에서 빨려 들어가 위에서 나온다. 나오는 칸의 온도는 빨려 들어간 칸의 평균으로 맞춰
  열이 사라지지 않게 한다(예전에는 주변 온도로 바뀌어 약 140 kW가 사라졌다. E0 2.21장).
- 차가운 통로 윗면: 퍼텐셜 흐름은 통로 윗면과 양끝을 구분하지 못해 윗면으로 공기가 너무 많이 들어온다(OpenFOAM은 양끝이 더 많다).
  랙 위 한 겹의 통과 쉬움 `SIGMA_COLD_TOP`(기본 0.1)을 줄여 양끝 유입을 늘린다. OpenFOAM 사례 B에 맞춘 **보정 상수**다(E0 2.23장).
- 시간 응답: 공기만 있는 모델은 실제보다 훨씬 빨리 변한다. `--slow`로 응답을 늦춘다(측정값이 아니라 조절값).
- 수치 확산: `--advection linear`(선형 보간)는 유효 확산 계수가 대략 u x dx / 2다. 격자 0.1 m에서 흐름 1 m/s이면 0.05 m2/s로
  설정한 `K_DIFF`(0.02)의 약 2.4배, 4 m/s이면 약 8배다(시간 간격을 줄여도 거의 줄지 않는다). 온도장이 설정값보다 더 흐리게 번진다.
  기본값 `maccormack`은 앞으로 갔다 되돌아와 오차를 구해 보정하고 결과를 주변 값 범위로 자른다. 같은 조건에서 덩어리가 퍼지는
  정도가 크게 줄었다(`experiments/results/E0_omniverse_capability_probe.md` 2.19장, `tests/test_advection.py`). 그래도 CFD는 아니다.

사용 (이 폴더에서):
    uv run --python 3.13 python hall60_sim.py [--duration 300] [--fail CRAC_01 --fail-time 60] [--power 10] [--advection linear|maccormack]
출력: out/hall60/ (frames/T_*.npy + frames_meta.json, sensors.csv, summary.json, slice_*.png)
"""
from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import warp as wp
from PIL import Image, ImageDraw
from pxr import Gf, Usd, UsdGeom

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = HERE / "out" / "hall60"
DX = 0.10            # 격자 간격 (m)
K_DIFF = 0.02        # 확산 계수 (m^2/s, 난류 혼합을 흉내 낸 값)
SIGMA_COLD_TOP = 0.1  # 차가운 통로 윗면(랙 높이 바로 위 한 겹)의 통과 쉬움(0~1). 1이면 퍼텐셜 흐름 그대로, 작을수록 윗면으로 들어오는 공기가 줄고 양끝으로 더 들어온다
RHO_CP = 1.2         # 공기의 밀도 x 비열 (kJ/(m^3 K))
V_RACK = 0.8         # 랙 안 공기 속도 (m/s)
T_SUPPLY = 18.0      # 급기 온도 (degC)
T_INIT = 24.0        # 초기 공기 온도 (degC)
VENT_LAYERS = 3      # 급기구 위 공기를 내보내는 층 수(30cm). 너무 얇으면 속도가 지나치게 커진다
RETURN_Z_CM = (10.0, 190.0)  # CRAC 회수면의 높이 범위


# =====================================================================
# 1) 장면 읽기
# =====================================================================
def read_hall(path: Path) -> dict:
    stage = Usd.Stage.Open(str(path))
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    hall = {"racks": [], "cracs": [], "vents": [], "panels": [], "anchors": [], "size_cm": None}
    for prim in stage.Traverse():
        if prim.GetName().startswith("Hall") and prim.GetAttribute("dct:hallSizeCm"):
            hall["size_cm"] = tuple(float(v) for v in prim.GetAttribute("dct:hallSizeCm").Get())
        at = prim.GetAttribute("dct:assetType")
        if not at or not at.Get():
            continue
        kind = at.Get()
        if kind in ("rack", "crac", "vent", "containment"):
            r = cache.ComputeWorldBound(prim).ComputeAlignedRange()
            item = {"name": prim.GetName(), "path": str(prim.GetPath()), "min": tuple(r.GetMin()), "max": tuple(r.GetMax())}
            if kind in ("rack", "crac"):
                m = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
                f = m.TransformDir(Gf.Vec3d(0, -1, 0))  # 에셋의 앞쪽은 로컬 -Y
                axis = int(np.argmax([abs(f[0]), abs(f[1])]))
                item["front"] = (axis, 1 if f[axis] > 0 else -1)  # (축, 부호): 앞면이 향하는 방향
            hall[{"rack": "racks", "crac": "cracs", "vent": "vents", "containment": "panels"}[kind]].append(item)
        elif kind == "sensor":
            m = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default()).ExtractTranslation()
            hall["anchors"].append({
                "path": str(prim.GetPath()), "equipment": prim.GetParent().GetParent().GetName(),
                "metric": prim.GetAttribute("dct:metric").Get(), "unit": prim.GetAttribute("dct:unit").Get(),
                "pos_cm": (m[0], m[1], m[2]),
            })
    for k in ("racks", "cracs", "vents"):
        hall[k].sort(key=lambda d: d["name"])
    if hall["size_cm"] is None:
        raise RuntimeError("홀 크기(dct:hallSizeCm)를 장면에서 찾지 못했다")
    return hall


def rng(lo_cm: float, hi_cm: float, n: int) -> tuple[int, int]:
    """cm 범위를 셀 인덱스 범위로. 얇은 판도 최소 한 칸을 차지한다."""
    i0 = int(np.floor(lo_cm / 100.0 / DX + 1e-6))
    i1 = max(i0 + 1, int(np.ceil(hi_cm / 100.0 / DX - 1e-6)))
    return max(0, i0), min(n, i1)


class Layout:
    """장면에서 격자 위의 칸 종류와 흐름의 원천을 만든다."""

    def __init__(self, hall: dict):
        W, L, H = hall["size_cm"]
        self.shape = (int(round(W / 100.0 / DX)), int(round(L / 100.0 / DX)), int(round(H / 100.0 / DX)))
        nx, ny, nz = self.shape
        self.rack_id = np.full(self.shape, -1, dtype=np.int32)
        self.rack_dir = np.zeros(self.shape + (3,), dtype=np.float32)   # 랙 안 속도 방향(앞 -> 뒤)
        self.solid = np.zeros(self.shape, dtype=bool)
        self.intake = np.zeros(self.shape, dtype=bool)
        self.exhaust = np.zeros(self.shape, dtype=bool)
        self.vent = np.zeros(self.shape, dtype=bool)
        self.ret_id = np.full(self.shape, -1, dtype=np.int32)
        self.intake_id = np.full(self.shape, -1, dtype=np.int32)   # 랙 앞면 바로 앞 칸: 그 랙의 번호
        self.exhaust_id = np.full(self.shape, -1, dtype=np.int32)  # 랙 뒷면 바로 뒤 칸: 그 랙의 번호
        self.vent_id = np.full(self.shape, -1, dtype=np.int32)     # 급기구 칸: 급기구 번호
        self.rack_flux = []
        for idx, r in enumerate(hall["racks"]):
            (x0, y0, z0), (x1, y1, z1) = r["min"], r["max"]
            xs, xe = rng(x0, x1, nx); ys, ye = rng(y0, y1, ny); zs, ze = rng(z0, z1, nz)
            self.rack_id[xs:xe, ys:ye, zs:ze] = idx
            self.solid[xs:xe, ys:ye, zs:ze] = True
            axis, sign = r["front"]
            through = np.zeros(3, dtype=np.float32); through[axis] = -sign * V_RACK  # 앞 -> 뒤
            self.rack_dir[xs:xe, ys:ye, zs:ze] = through
            sl = [slice(xs, xe), slice(ys, ye), slice(zs, ze)]
            lo, hi = (xs, ys)[axis], (xe, ye)[axis]
            front_sl, back_sl = list(sl), list(sl)
            front_sl[axis] = slice(hi, hi + 1) if sign > 0 else slice(lo - 1, lo)
            back_sl[axis] = slice(lo - 1, lo) if sign > 0 else slice(hi, hi + 1)
            self.intake[tuple(front_sl)] = True
            self.exhaust[tuple(back_sl)] = True
            self.intake_id[tuple(front_sl)] = idx
            self.exhaust_id[tuple(back_sl)] = idx
            area = ((x1 - x0) / 100.0 if axis == 1 else (y1 - y0) / 100.0) * ((z1 - z0) / 100.0)
            self.rack_flux.append(V_RACK * area)
        self.crac_q = []
        for idx, c in enumerate(hall["cracs"]):
            (x0, y0, z0), (x1, y1, z1) = c["min"], c["max"]
            xs, xe = rng(x0, x1, nx); ys, ye = rng(y0, y1, ny); zs, ze = rng(z0, z1, nz)
            self.solid[xs:xe, ys:ye, zs:ze] = True
            axis, sign = c["front"]  # 회수면(앞면)이 향하는 방향
            zr0, zr1 = rng(RETURN_Z_CM[0], RETURN_Z_CM[1], nz)
            if axis == 0:
                xr = slice(xe, xe + 1) if sign > 0 else slice(xs - 1, xs)
                self.ret_id[xr, ys:ye, zr0:zr1] = idx
            else:
                yr = slice(ye, ye + 1) if sign > 0 else slice(ys - 1, ys)
                self.ret_id[xs:xe, yr, zr0:zr1] = idx
        for p in hall["panels"]:
            (x0, y0, z0), (x1, y1, z1) = p["min"], p["max"]
            xs, xe = rng(x0, x1, nx); ys, ye = rng(y0, y1, ny); zs, ze = rng(z0, z1, nz)
            self.solid[xs:xe, ys:ye, zs:ze] = True
        for vi, v in enumerate(hall["vents"]):
            (x0, y0, z0), (x1, y1, z1) = v["min"], v["max"]
            xs, xe = rng(x0, x1, nx); ys, ye = rng(y0, y1, ny)
            self.vent[xs:xe, ys:ye, 0:VENT_LAYERS] = True
            self.vent_id[xs:xe, ys:ye, 0:VENT_LAYERS] = vi
        self.fluid = ~self.solid
        for a in ("intake", "exhaust", "vent"):
            setattr(self, a, getattr(self, a) & self.fluid)
        for a in ("intake_id", "exhaust_id", "vent_id"):
            getattr(self, a)[~self.fluid] = -1
        self.ret_id[~self.fluid] = -1
        self.n_cracs = len(hall["cracs"])
        # 차가운 통로 윗면 한 겹(랙 위): 통과 쉬움 sigma를 줄여 윗면으로 들어오는 공기를 줄인다(SIGMA_COLD_TOP). 퍼텐셜 흐름은 윗면과 양끝을 구분하지 못해서 윗면으로 너무 많이 들어온다.
        self.sigma = np.ones(self.shape)
        if SIGMA_COLD_TOP != 1.0 and hall["vents"] and hall["racks"]:
            cy = sorted({round((v["min"][1] + v["max"][1]) / 2 / 10.0) * 10.0 for v in hall["vents"]})
            xa, xb = min(r["min"][0] for r in hall["racks"]), max(r["max"][0] for r in hall["racks"])
            ztop = max(r["max"][2] for r in hall["racks"])
            kz = int(np.floor(ztop / 100.0 / DX + 1e-6))
            for y in cy:
                xs, xe = rng(xa, xb, nx); ys, ye = rng(y - 60.0, y + 60.0, ny)
                if kz < nz:
                    self.sigma[xs:xe, ys:ye, kz] = SIGMA_COLD_TOP
        # 뜨거운 통로: CRAC의 y 위치(뜨거운 통로 끝에 놓임)로 통로를 나누고, 랙은 뒷면이 닿는 통로에 배정한다.
        centers = sorted({round((c["min"][1] + c["max"][1]) / 2 / 10.0) * 10.0 for c in hall["cracs"]})
        self.n_aisles = len(centers)
        near = lambda y: int(np.argmin([abs(y - c) for c in centers]))
        self.crac_aisle = [near((c["min"][1] + c["max"][1]) / 2) for c in hall["cracs"]]
        self.aisle_exhaust = np.zeros(self.n_aisles)
        for r, q in zip(hall["racks"], self.rack_flux):
            axis, sign = r["front"]
            back_y = r["min"][1] if sign > 0 else r["max"][1]
            self.aisle_exhaust[near(back_y)] += q
        # 차가운 통로: 급기구가 놓인 y 위치(통로 가운데)로 나누고, 랙은 앞면이 닿는 통로, 급기구는 가장 가까운 통로에 배정한다.
        cold_centers = sorted({round((v["min"][1] + v["max"][1]) / 2 / 10.0) * 10.0 for v in hall["vents"]})
        self.n_cold = len(cold_centers)
        near_cold = lambda y: int(np.argmin([abs(y - c) for c in cold_centers]))
        self.vent_cold = [near_cold((v["min"][1] + v["max"][1]) / 2) for v in hall["vents"]]
        self.rack_cold = []
        for r in hall["racks"]:
            axis, sign = r["front"]
            self.rack_cold.append(near_cold(((r["max"][1] if sign > 0 else r["min"][1]) if axis == 1 else (r["min"][1] + r["max"][1]) / 2)))
        n_per_aisle = np.bincount(self.crac_aisle, minlength=self.n_aisles)
        # CRAC는 모두 같은 장비라고 보고, 용량은 가장 바쁜 통로를 정상 상태에서 감당하는 값으로 둔다
        self.q_cap = float(max(self.aisle_exhaust[a] / max(1, n_per_aisle[a]) for a in range(self.n_aisles)))
        # 격벽 지붕 틈: 용량을 넘는 뜨거운 공기가 새는 곳(지붕 바로 아래 칸 -> 지붕 바로 위 칸)
        roofs = sorted([p for p in hall["panels"] if p["name"].endswith("_Roof")], key=lambda p: p["min"][1])
        self.leak_sink = [np.zeros(self.shape, dtype=bool) for _ in range(self.n_aisles)]
        self.leak_src = [np.zeros(self.shape, dtype=bool) for _ in range(self.n_aisles)]
        for a, p in enumerate(roofs[: self.n_aisles]):
            (x0, y0, z0), (x1, y1, z1) = p["min"], p["max"]
            xs, xe = rng(x0, x1, nx); ys, ye = rng(y0, y1, ny); zs, ze = rng(z0, z1, nz)
            self.leak_sink[a][xs:xe, ys:ye, zs - 1] = True
            self.leak_src[a][xs:xe, ys:ye, ze] = True
        for a in range(self.n_aisles):
            self.leak_sink[a] &= self.fluid
            self.leak_src[a] &= self.fluid


# =====================================================================
# 2) 공기 흐름(질량 보존 퍼텐셜 흐름)
# =====================================================================
def crac_returns(lay: Layout, fan: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """CRAC별 회수 유량(m^3/s)과 통로별 새는 유량. 통로의 배기를 켜진 CRAC들이 나눠 맡고, 용량을 넘으면 지붕 틈으로 샌다."""
    q = np.zeros(lay.n_cracs)
    leak = np.zeros(lay.n_aisles)
    for a in range(lay.n_aisles):
        idx = [i for i in range(lay.n_cracs) if lay.crac_aisle[i] == a and fan[i] > 0]
        if idx:
            share = lay.aisle_exhaust[a] / len(idx)
            for i in idx:
                q[i] = min(lay.q_cap * float(fan[i]), share)
        leak[a] = max(0.0, lay.aisle_exhaust[a] - q[[i for i in range(lay.n_cracs) if lay.crac_aisle[i] == a]].sum())
    return q, leak


def source_field(lay: Layout, fan: np.ndarray) -> tuple[np.ndarray, dict]:
    """셀마다 원천 세기(1/s). 양수는 내보냄, 음수는 빨아들임."""
    s = np.zeros(lay.shape, dtype=np.float64)
    vol = DX ** 3
    q, leak = crac_returns(lay, fan)
    for idx in range(lay.n_cracs):
        ret = lay.ret_id == idx
        if q[idx] > 0 and ret.any():
            s[ret] -= q[idx] / (ret.sum() * vol)
    q_rack = float(sum(lay.rack_flux))
    flux = np.array(lay.rack_flux, dtype=np.float64)
    # 랙마다: 흡입면과 배기면 칸이 그 랙의 유량을 나눈다(랙 하나를 빼거나 옮겨도 다른 랙의 원천은 그대로다)
    for ids, sign in ((lay.intake_id, -1.0), (lay.exhaust_id, 1.0)):
        cnt = np.bincount(ids[ids >= 0], minlength=len(flux)).astype(np.float64)
        per_cell = np.divide(flux, cnt, out=np.zeros_like(flux), where=cnt > 0) / vol
        m = ids >= 0
        s[m] += sign * per_cell[ids[m]]
    # 급기: 켜진 CRAC들의 회수 유량 합(q.sum())을 차가운 통로별로, 그 통로를 향한 랙들의 유량 비율로 나눈다.
    # 통로 안에서는 그 통로의 급기구 칸이 똑같이 받는다. (예전에는 급기구 전체가 똑같이 받아서 먼 통로의 랙이 영향을 받았다)
    if q.sum() > 0:
        demand = np.zeros(lay.n_cold)
        for r_idx, c in enumerate(lay.rack_cold):
            demand[c] += flux[r_idx]
        for c in range(lay.n_cold):
            if demand[c] <= 0:
                continue
            cells = (lay.vent_id >= 0) & (np.array(lay.vent_cold)[np.maximum(lay.vent_id, 0)] == c)
            if not cells.any():
                raise RuntimeError(f"차가운 통로 {c}에 랙이 있는데 급기구가 없다")
            s[cells] += q.sum() * (demand[c] / demand.sum()) / (cells.sum() * vol)
    for a in range(lay.n_aisles):
        if leak[a] > 1e-9:
            if not (lay.leak_sink[a].any() and lay.leak_src[a].any()):
                raise RuntimeError(f"통로 {a}의 배기 {leak[a]:.2f} m3/s가 새야 하는데 격벽 지붕 틈 칸이 없다(장면에 `*_Roof` 격벽이 통로 수만큼 있어야 한다)")
            s[lay.leak_sink[a]] -= leak[a] / (lay.leak_sink[a].sum() * vol)
            s[lay.leak_src[a]] += leak[a] / (lay.leak_src[a].sum() * vol)
    return s, {"crac_return_m3s": [round(float(x), 2) for x in q], "aisle_leak_m3s": [round(float(x), 2) for x in leak], "supply_m3s": round(float(q.sum()), 2), "rack_m3s": round(q_rack, 2)}


def solve_flow(lay: Layout, s: np.ndarray) -> tuple[np.ndarray, dict]:
    """∇²φ = s 를 푼다(벽, 고체는 흐름이 드나들지 않음). u = ∇φ를 셀 중심 속도(m/s)로 돌려준다."""
    fluid = lay.fluid
    idx = -np.ones(fluid.shape, dtype=np.int64)
    idx[fluid] = np.arange(fluid.sum())
    n = int(fluid.sum())
    rows, cols, vals = [], [], []
    diag = np.zeros(n)
    for axis in range(3):
        for sign in (-1, 1):
            nb = np.roll(fluid, -sign, axis=axis)
            edge = [slice(None)] * 3
            edge[axis] = slice(-1, None) if sign == 1 else slice(0, 1)
            nb[tuple(edge)] = False
            both = fluid & nb
            ii = idx[both]
            jj = np.roll(idx, -sign, axis=axis)[both]
            sg = lay.sigma
            sj = np.roll(sg, -sign, axis=axis)
            w = (2.0 * sg * sj / (sg + sj))[both]  # 면의 통과 쉬움: 두 칸의 조화 평균
            rows.append(ii); cols.append(jj); vals.append(w)
            np.add.at(diag, ii, -w)
    A = sp.coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr() + sp.diags(diag)
    b = s[fluid] * DX * DX
    scale = float(np.abs(b).sum())
    imbalance = abs(float(b.sum())) / scale if scale > 0 else 0.0
    if imbalance > 1e-6:  # 평균을 빼서 풀리게 만들 수는 있지만 그러면 틀린 흐름을 조용히 받아들이게 된다
        raise RuntimeError(f"원천의 합이 0이 아니다(상대 {imbalance:.2e}). 급기, 회수, 랙 앞뒤, 지붕 틈의 유량이 맞지 않는다")
    b = b - b.mean()  # 부동소수점 오차만 정리한다
    A = -A  # 양의 정부호로 바꿔 CG를 쓴다: -∇²φ = -s
    b = -b
    M = sp.diags(1.0 / np.maximum(A.diagonal(), 1e-9))
    t0 = time.time()
    phi_vec, info = spla.cg(A + sp.identity(n) * 1e-9, b, rtol=1e-7, maxiter=20000, M=M)
    resid = float(np.linalg.norm(A @ phi_vec - b) / max(float(np.linalg.norm(b)), 1e-30))
    if info != 0 or resid > 1e-4:
        raise RuntimeError(f"공기 흐름 풀이가 수렴하지 못했다(info={info}, 상대 잔차 {resid:.2e}). 닫힌 칸이나 원천 배치를 확인한다")
    phi = np.zeros(fluid.shape)
    phi[fluid] = phi_vec
    u = np.zeros(fluid.shape + (3,), dtype=np.float32)
    sg = lay.sigma
    for axis in range(3):
        # 셀 중심 속도 = 양쪽 면을 지나는 유량의 평균. 면의 유량 = 면의 통과 쉬움 x 퍼텐셜 차 / DX.
        # (중심 차분으로 만들면 통과 쉬움이 작은 막 바로 옆 칸의 속도가 막 양쪽의 퍼텐셜 차를 그대로 받아 과대해진다.)
        flux = []
        for sign in (1, -1):
            nb_phi = np.roll(phi, -sign, axis=axis)
            nb_fluid = np.roll(fluid, -sign, axis=axis)
            edge = [slice(None)] * 3
            edge[axis] = slice(-1, None) if sign == 1 else slice(0, 1)
            nb_fluid[tuple(edge)] = False
            w = 2.0 * sg * np.roll(sg, -sign, axis=axis) / (sg + np.roll(sg, -sign, axis=axis))
            f = np.where(fluid & nb_fluid, w * (nb_phi - phi) / DX, 0.0)  # 이 칸에서 sign 방향 이웃으로 나가는 쪽의 기울기 x 쉬움
            flux.append(f * sign)  # +방향 속도로 환산: 이웃이 +쪽이면 그대로, -쪽이면 부호를 뒤집는다
        u[..., axis] = (0.5 * (flux[0] + flux[1])).astype(np.float32)
    u[~fluid] = 0.0
    inside = lay.rack_id >= 0
    u[inside] = lay.rack_dir[inside]  # 랙 안은 정해 둔 통과 속도
    speed = np.linalg.norm(u, axis=-1)
    return u, {"solve_s": round(time.time() - t0, 1), "cg_info": int(info), "residual": float(f"{resid:.2e}"), "cells": n, "max_speed_ms": round(float(speed.max()), 2), "p99_speed_ms": round(float(np.percentile(speed[fluid], 99)), 2)}


# =====================================================================
# 3) Warp 열 시뮬레이션
# =====================================================================
@wp.func
def sample_T(T: wp.array3d(dtype=float), p: wp.vec3, nx: int, ny: int, nz: int):
    x = wp.clamp(p[0], 0.0, float(nx - 1))
    y = wp.clamp(p[1], 0.0, float(ny - 1))
    z = wp.clamp(p[2], 0.0, float(nz - 1))
    i0 = int(wp.floor(x)); j0 = int(wp.floor(y)); k0 = int(wp.floor(z))
    i1 = wp.min(i0 + 1, nx - 1); j1 = wp.min(j0 + 1, ny - 1); k1 = wp.min(k0 + 1, nz - 1)
    fx = x - float(i0); fy = y - float(j0); fz = z - float(k0)
    c00 = T[i0, j0, k0] * (1.0 - fx) + T[i1, j0, k0] * fx
    c10 = T[i0, j1, k0] * (1.0 - fx) + T[i1, j1, k0] * fx
    c01 = T[i0, j0, k1] * (1.0 - fx) + T[i1, j0, k1] * fx
    c11 = T[i0, j1, k1] * (1.0 - fx) + T[i1, j1, k1] * fx
    c0 = c00 * (1.0 - fy) + c10 * fy
    c1 = c01 * (1.0 - fy) + c11 * fy
    return c0 * (1.0 - fz) + c1 * fz


@wp.func
def neighbor_range(T: wp.array3d(dtype=float), p: wp.vec3, nx: int, ny: int, nz: int):
    """p를 둘러싼 8칸의 (최솟값, 최댓값). MacCormack 결과가 주변 값 범위를 벗어나지 않게 자르는 데 쓴다."""
    x = wp.clamp(p[0], 0.0, float(nx - 1))
    y = wp.clamp(p[1], 0.0, float(ny - 1))
    z = wp.clamp(p[2], 0.0, float(nz - 1))
    i0 = int(wp.floor(x)); j0 = int(wp.floor(y)); k0 = int(wp.floor(z))
    i1 = wp.min(i0 + 1, nx - 1); j1 = wp.min(j0 + 1, ny - 1); k1 = wp.min(k0 + 1, nz - 1)
    lo = T[i0, j0, k0]
    hi = lo
    for di in range(2):
        for dj in range(2):
            for dk in range(2):
                v = T[i0 + di * (i1 - i0), j0 + dj * (j1 - j0), k0 + dk * (k1 - k0)]
                lo = wp.min(lo, v)
                hi = wp.max(hi, v)
    return wp.vec2(lo, hi)


@wp.kernel
def advect_forward_kernel(
    T: wp.array3d(dtype=float), T_hat: wp.array3d(dtype=float), u: wp.array3d(dtype=wp.vec3),
    solid: wp.array3d(dtype=int), rack_id: wp.array3d(dtype=int), dt: float, dx: float,
):
    """MacCormack 1단계: 거슬러 올라가 값을 가져온다(기존 방식과 같다)."""
    i, j, k = wp.tid()
    if solid[i, j, k] == 1 and rack_id[i, j, k] < 0:
        T_hat[i, j, k] = T[i, j, k]
        return
    p = wp.vec3(float(i), float(j), float(k)) - u[i, j, k] * (dt / dx)
    T_hat[i, j, k] = sample_T(T, p, T.shape[0], T.shape[1], T.shape[2])


@wp.kernel
def step_kernel_mc(
    T: wp.array3d(dtype=float), T_hat: wp.array3d(dtype=float), T_out: wp.array3d(dtype=float), u: wp.array3d(dtype=wp.vec3),
    solid: wp.array3d(dtype=int), rack_id: wp.array3d(dtype=int), vent: wp.array3d(dtype=int),
    heat_rate: wp.array(dtype=float), dt: float, dx: float, k_diff: float, t_supply: float, vent_on: float,
):
    """MacCormack 2단계: 앞으로 되돌려 보내 오차를 구하고 절반을 보정한다. 결과는 출발 지점 주변 값의 범위로 자른다."""
    i, j, k = wp.tid()
    nx = T.shape[0]; ny = T.shape[1]; nz = T.shape[2]
    if solid[i, j, k] == 1 and rack_id[i, j, k] < 0:
        T_out[i, j, k] = T[i, j, k]
        return
    pos = wp.vec3(float(i), float(j), float(k))
    shift = u[i, j, k] * (dt / dx)
    t_hat = T_hat[i, j, k]
    t_back = sample_T(T_hat, pos + shift, nx, ny, nz)
    c = T[i, j, k]
    t_adv = t_hat + 0.5 * (c - t_back)
    rng = neighbor_range(T, pos - shift, nx, ny, nz)
    t_adv = wp.clamp(t_adv, rng[0], rng[1])
    lap = (T[wp.max(i - 1, 0), j, k] + T[wp.min(i + 1, nx - 1), j, k] + T[i, wp.max(j - 1, 0), k] + T[i, wp.min(j + 1, ny - 1), k]
           + T[i, j, wp.max(k - 1, 0)] + T[i, j, wp.min(k + 1, nz - 1)] - 6.0 * c) / (dx * dx)
    t_new = t_adv + k_diff * lap * dt
    rid = rack_id[i, j, k]
    if rid >= 0:
        t_new = t_new + heat_rate[rid] * dt
    if vent[i, j, k] == 1 and vent_on > 0.0:
        t_new = t_supply
    T_out[i, j, k] = t_new


@wp.kernel
def step_kernel(
    T: wp.array3d(dtype=float), T_out: wp.array3d(dtype=float), u: wp.array3d(dtype=wp.vec3),
    solid: wp.array3d(dtype=int), rack_id: wp.array3d(dtype=int), vent: wp.array3d(dtype=int),
    heat_rate: wp.array(dtype=float), dt: float, dx: float, k_diff: float, t_supply: float, vent_on: float,
):
    i, j, k = wp.tid()
    nx = T.shape[0]; ny = T.shape[1]; nz = T.shape[2]
    if solid[i, j, k] == 1 and rack_id[i, j, k] < 0:
        T_out[i, j, k] = T[i, j, k]  # 격벽, CRAC 몸체: 온도 변화 없음
        return
    p = wp.vec3(float(i), float(j), float(k)) - u[i, j, k] * (dt / dx)
    t_adv = sample_T(T, p, nx, ny, nz)
    c = T[i, j, k]
    lap = (T[wp.max(i - 1, 0), j, k] + T[wp.min(i + 1, nx - 1), j, k] + T[i, wp.max(j - 1, 0), k] + T[i, wp.min(j + 1, ny - 1), k]
           + T[i, j, wp.max(k - 1, 0)] + T[i, j, wp.min(k + 1, nz - 1)] - 6.0 * c) / (dx * dx)
    t_new = t_adv + k_diff * lap * dt
    rid = rack_id[i, j, k]
    if rid >= 0:
        t_new = t_new + heat_rate[rid] * dt
    if vent[i, j, k] == 1 and vent_on > 0.0:
        t_new = t_supply
    T_out[i, j, k] = t_new


@wp.kernel
def leak_sum_kernel(T: wp.array3d(dtype=float), sink_id: wp.array3d(dtype=int), sums: wp.array(dtype=float)):
    """통로별 지붕 틈 아래(빨아들이는) 칸의 온도를 모두 더한다."""
    i, j, k = wp.tid()
    a = sink_id[i, j, k]
    if a >= 0:
        wp.atomic_add(sums, a, T[i, j, k])


@wp.kernel
def leak_apply_kernel(T: wp.array3d(dtype=float), src_id: wp.array3d(dtype=int), sums: wp.array(dtype=float), counts: wp.array(dtype=float), leak_on: wp.array(dtype=float)):
    """새는 공기가 나오는 칸(지붕 틈 위)의 온도를 빨려 들어간 칸의 평균으로 맞춘다. 새는 공기가 열을 그대로 가지고 나오게 한다."""
    i, j, k = wp.tid()
    a = src_id[i, j, k]
    if a >= 0 and leak_on[a] > 0.0 and counts[a] > 0.0:
        T[i, j, k] = sums[a] / counts[a]


@wp.kernel
def sample_points(T: wp.array3d(dtype=float), pts: wp.array(dtype=wp.vec3), out: wp.array(dtype=float)):
    n = wp.tid()
    out[n] = sample_T(T, pts[n], T.shape[0], T.shape[1], T.shape[2])


class Sim:
    def __init__(self, hall: dict, lay: Layout, power_kw: float, slow: float, device: str = "cuda:0", advection: str = "maccormack", t_supply: float = T_SUPPLY):
        if advection not in ("linear", "maccormack"):
            raise ValueError(f"advection은 linear 또는 maccormack이어야 한다: {advection}")
        self.advection = advection  # linear: 거슬러 올라가 선형 보간(수치 확산이 큼), maccormack: 오차 보정 + 값 제한(확산이 작음)
        self.hall, self.lay, self.device, self.slow = hall, lay, device, slow
        # 급기 온도. 식이 온도에 대해 선형이라 급기를 올리면 장 전체가 같은 폭으로 오른다(초기 온도도 같은 폭으로 옮겨 과도 구간을 같게 한다).
        self.t_supply = float(t_supply)
        self.t_init = T_INIT + (self.t_supply - T_SUPPLY)
        self.dt_phys = min(0.04, 0.09 * DX * DX / K_DIFF)  # 확산 안정 조건 K dt/dx^2 <= 0.1
        self.dt = self.dt_phys / slow  # 물리 시간을 늘려 응답을 늦춘다
        d = device
        self.solid = wp.array(lay.solid.astype(np.int32), dtype=int, device=d)
        self.rack_id = wp.array(lay.rack_id, dtype=int, device=d)
        self.vent = wp.array(lay.vent.astype(np.int32), dtype=int, device=d)
        self.T = wp.array(np.full(lay.shape, self.t_init, dtype=np.float32), dtype=float, device=d)
        self.T2 = wp.zeros(lay.shape, dtype=float, device=d)
        self.T_hat = wp.zeros(lay.shape, dtype=float, device=d)
        # 새는 공기(격벽 지붕 틈): 빨려 들어간 칸의 온도를 나오는 칸으로 옮긴다(옮기지 않으면 열이 사라진다)
        sink_id = np.full(lay.shape, -1, dtype=np.int32)
        src_id = np.full(lay.shape, -1, dtype=np.int32)
        for a in range(lay.n_aisles):
            sink_id[lay.leak_sink[a]] = a
            src_id[lay.leak_src[a]] = a
        self.leak_sink_id = wp.array(sink_id, dtype=int, device=d)
        self.leak_src_id = wp.array(src_id, dtype=int, device=d)
        self.leak_sums = wp.zeros(max(1, lay.n_aisles), dtype=float, device=d)
        self.leak_counts = wp.array(np.array([float(lay.leak_sink[a].sum()) for a in range(lay.n_aisles)] or [0.0], dtype=np.float32), dtype=float, device=d)
        self.leak_on = wp.zeros(max(1, lay.n_aisles), dtype=float, device=d)
        self.set_power(np.full(len(hall["racks"]), power_kw, dtype=np.float32))
        self.u = None
        self.vent_on = 1.0
        self.flow_info = {}

    def set_power(self, kw: np.ndarray):
        # 랙을 지나는 공기의 온도 상승 = P / (rho cp q). 랙 안 머무는 시간 동안 균일하게 가열한다.
        q = np.array(self.lay.rack_flux, dtype=np.float32)
        depth_m = 1.0
        rate = (kw / (RHO_CP * q)) * (V_RACK / depth_m)  # K/s
        self.heat_rate = wp.array(rate.astype(np.float32), dtype=float, device=self.device)

    def set_fans(self, fan: np.ndarray):
        s, balance = source_field(self.lay, fan)
        u, info = solve_flow(self.lay, s)
        info.update(balance)
        self.leak_on = wp.array(np.array([1.0 if x > 1e-9 else 0.0 for x in balance["aisle_leak_m3s"]] or [0.0], dtype=np.float32), dtype=float, device=self.device)
        self.vent_on = 1.0 if balance["supply_m3s"] > 0 else 0.0  # 켜진 CRAC가 하나도 없으면 급기구에서 찬 공기가 나오지 않는다
        self.u = wp.array(u, dtype=wp.vec3, device=self.device)
        self.flow_info = info
        self.u_np = u

    def step(self):
        self.leak_sums.zero_()
        wp.launch(leak_sum_kernel, dim=self.lay.shape, inputs=[self.T, self.leak_sink_id, self.leak_sums], device=self.device)
        if self.advection == "maccormack":
            wp.launch(advect_forward_kernel, dim=self.lay.shape, inputs=[self.T, self.T_hat, self.u, self.solid, self.rack_id, self.dt, DX], device=self.device)
            wp.launch(step_kernel_mc, dim=self.lay.shape, inputs=[self.T, self.T_hat, self.T2, self.u, self.solid, self.rack_id, self.vent, self.heat_rate,
                                                                   self.dt, DX, K_DIFF, self.t_supply, self.vent_on], device=self.device)
        else:
            wp.launch(step_kernel, dim=self.lay.shape, inputs=[self.T, self.T2, self.u, self.solid, self.rack_id, self.vent, self.heat_rate,
                                                               self.dt, DX, K_DIFF, self.t_supply, self.vent_on], device=self.device)
        self.T, self.T2 = self.T2, self.T
        wp.launch(leak_apply_kernel, dim=self.lay.shape, inputs=[self.T, self.leak_src_id, self.leak_sums, self.leak_counts, self.leak_on], device=self.device)

    def sensors(self, anchors: list[dict]) -> np.ndarray:
        pts = np.array([[a["pos_cm"][i] / 100.0 / DX - 0.5 for i in range(3)] for a in anchors], dtype=np.float32)
        out = wp.zeros(len(anchors), dtype=float, device=self.device)
        wp.launch(sample_points, dim=len(anchors), inputs=[self.T, wp.array(pts, dtype=wp.vec3, device=self.device), out], device=self.device)
        return out.numpy()


def colorize(t: np.ndarray, lo: float = 18.0, hi: float = 40.0) -> np.ndarray:
    x = np.clip((t - lo) / (hi - lo), 0, 1)
    r = np.clip(3 * x - 1, 0, 1); g = np.clip(1.5 - np.abs(3 * x - 1.5), 0, 1); b = np.clip(1 - 3 * x, 0, 1)
    return (np.stack([r, g, b], axis=-1) * 255).astype(np.uint8)


def save_slice(T: np.ndarray, lay: Layout, z_cm: float, path: Path, label: str, scale: int = 5) -> None:
    k = int(z_cm / 100.0 / DX)
    plane = T[:, :, k].T[::-1]  # (y, x), 위가 +y
    rgb = colorize(plane)
    solid = lay.solid[:, :, k].T[::-1]
    rgb[solid] = (60, 60, 70)
    im = Image.fromarray(rgb).resize((rgb.shape[1] * scale, rgb.shape[0] * scale), Image.NEAREST)
    canvas = Image.new("RGB", (im.width, im.height + 20), (18, 18, 22))
    canvas.paste(im, (0, 0))
    ImageDraw.Draw(canvas).text((6, im.height + 4), label, fill=(255, 255, 255))
    canvas.save(path)


def main() -> None:
    ap = argparse.ArgumentParser(description="랙 60기 홀 열 시뮬레이션(시각화용)")
    ap.add_argument("--scene", type=Path, default=ROOT / "usd" / "scenes" / "hall01.usda")
    ap.add_argument("--duration", type=int, default=300, help="시뮬레이션 시간(초)")
    ap.add_argument("--fail", default="CRAC_02,CRAC_06", help="정지시킬 CRAC 이름(쉼표로 여러 대). 빈 문자열이면 고장 없음. 기본값은 한 통로를 맡은 CRAC 2대")
    ap.add_argument("--fail-time", type=int, default=60)
    ap.add_argument("--power", type=float, default=10.0, help="랙 1기 전력(kW)")
    ap.add_argument("--slow", type=float, default=10.0, help="응답을 늦추는 배수(조절값)")
    ap.add_argument("--every", type=int, default=20, help="몇 초마다 프레임 저장")
    ap.add_argument("--advection", choices=["linear", "maccormack"], default="maccormack", help="이류 계산 방식(수치 확산 비교용)")
    args = ap.parse_args()
    wp.config.quiet = True
    wp.init()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "frames").mkdir(exist_ok=True)
    for old in (OUT / "frames").glob("T_*.npy"):
        old.unlink()

    hall = read_hall(args.scene)
    lay = Layout(hall)
    names = [c["name"] for c in hall["cracs"]]
    print(f"장면: 랙 {len(hall['racks'])}기, CRAC {len(names)}기, 급기구 {len(hall['vents'])}개, 격벽 {len(hall['panels'])}개, 격자 {lay.shape}, 칸 {int(np.prod(lay.shape)):,}")
    sim = Sim(hall, lay, args.power, args.slow, advection=args.advection)
    fan = np.ones(len(names), dtype=np.float32)
    sim.set_fans(fan)
    print("정상 흐름:", sim.flow_info)

    racks = hall["racks"]
    rack_names = [r["name"] for r in racks]
    anc = [a for a in hall["anchors"] if a["equipment"].startswith("Rack_") and a["metric"] in ("temp_in", "temp_out")]
    anc.sort(key=lambda a: (a["equipment"], a["metric"]))
    steps_per_s = int(round(1.0 / sim.dt_phys))
    rows, frames, flow_fail = [], [], None
    sensor_hdr = ["t_s"] + [f"{a['equipment']}.{a['metric']}" for a in anc]
    t_wall = time.time()
    for s in range(1, args.duration + 1):
        if args.fail and s == args.fail_time + 1:
            for nm in args.fail.split(","):
                fan[names.index(nm.strip())] = 0.0
            sim.set_fans(fan)
            flow_fail = dict(sim.flow_info)
            print(f"{args.fail} 정지(t={args.fail_time}s):", flow_fail)
        for _ in range(steps_per_s):
            sim.step()
        if s % 5 == 0:
            rows.append([s] + [round(float(v), 2) for v in sim.sensors(anc)])
        if s % args.every == 0:
            T = sim.T.numpy().astype(np.float32)
            np.save(OUT / "frames" / f"T_{s:04d}.npy", T)
            frames.append({"t_s": s, "file": f"T_{s:04d}.npy", "min": round(float(T.min()), 2), "max": round(float(T.max()), 2)})
    wall = time.time() - t_wall
    meta = {"voxel_size_m": DX, "shape_xyz": list(lay.shape), "background_degC": T_INIT, "frames": frames}
    (OUT / "frames" / "frames_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    with open(OUT / "sensors.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(sensor_hdr); w.writerows(rows)

    # 요약: 랙 입구 온도(temp_in)의 분포와 줄 위치별 차이
    cols = {h: i for i, h in enumerate(sensor_hdr)}
    def at(t, key):
        row = next(r for r in rows if r[0] == t)
        return row[cols[key]]
    t_before = args.fail_time if args.fail else args.duration
    t_end = rows[-1][0]
    inlet_before = np.array([at(t_before, f"{n}.temp_in") for n in rack_names])
    inlet_end = np.array([at(t_end, f"{n}.temp_in") for n in rack_names])
    # 줄 안의 위치: 앞면이 향하는 축과 직각인 좌표가 같은 랙끼리 한 줄이고, 줄의 양 끝 랙과 가운데 랙을 나눈다.
    # 랙 수나 줄 길이가 바뀌어도(랙을 빼거나 옮긴 장면) 장면에서 읽은 위치로 정한다.
    by_row: dict = {}
    for ri, r in enumerate(hall["racks"]):
        ax = r["front"][0]  # 앞면이 향하는 축(0 = x, 1 = y)
        c = [(r["min"][d] + r["max"][d]) / 2 for d in range(2)]
        by_row.setdefault((ax, round(c[ax] / 10.0)), []).append((c[1 - ax], ri))
    is_end = np.zeros(len(rack_names), dtype=bool)
    is_mid = np.zeros(len(rack_names), dtype=bool)
    for members in by_row.values():
        members.sort()
        for k, (_, ri) in enumerate(members):
            if k == 0 or k == len(members) - 1:
                is_end[ri] = True
            else:
                is_mid[ri] = True
    def pos_stats(arr):
        return {"end_racks_mean": round(float(arr[is_end].mean()), 2) if is_end.any() else None,
                "middle_racks_mean": round(float(arr[is_mid].mean()), 2) if is_mid.any() else None}
    summary = {
        "scene": str(args.scene), "grid": list(lay.shape), "dt_phys_s": sim.dt_phys, "slow_factor": args.slow, "power_kw_per_rack": args.power,
        "flow_normal": sim.flow_info if flow_fail is None else None, "flow_fail": flow_fail, "fail": args.fail, "fail_time_s": args.fail_time,
        "rack_inlet_C": {
            f"t={t_before}s": {"min": round(float(inlet_before.min()), 2), "mean": round(float(inlet_before.mean()), 2), "max": round(float(inlet_before.max()), 2), **pos_stats(inlet_before)},
            f"t={t_end}s": {"min": round(float(inlet_end.min()), 2), "mean": round(float(inlet_end.mean()), 2), "max": round(float(inlet_end.max()), 2), **pos_stats(inlet_end)},
        },
        "hottest_inlet_racks_end": [rack_names[i] for i in np.argsort(-inlet_end)[:5]],
        "wall_clock_s": round(wall, 1), "realtime_ratio": round(args.duration / wall, 1),
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    for f in frames:
        if f["t_s"] in (args.fail_time if args.fail else args.every, args.duration):
            T = np.load(OUT / "frames" / f["file"])
            save_slice(T, lay, 120.0, OUT / f"slice_z120_t{f['t_s']:04d}.png", f"z=1.2m t={f['t_s']}s")
    save_slice(sim.T.numpy(), lay, 120.0, OUT / "slice_z120_final.png", f"z=1.2m t={args.duration}s")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
