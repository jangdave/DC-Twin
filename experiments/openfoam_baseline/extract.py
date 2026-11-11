"""OpenFOAM 결과(마지막 시각의 T, U)에서 랙 입구 온도를 뽑아 CSV로 저장한다. WSL의 python3(numpy)로 실행한다.

이 설치(Ubuntu 패키지 v1912)는 함수 객체(probes, postProcess)가 'sha1' 오류로 죽어서 쓰지 못했다. 그래서 결과 파일을 직접 읽는다.
메시는 한 덩어리 격자에서 고체 칸만 뺀 것이라, 남은 칸의 순서 = 원래 칸 순서(x가 가장 빠름)에서 고체를 뺀 순서다(case_voxels.npz).

사용: python3 extract.py <실행 폴더> <결과 CSV 접두(예: .../rack_inlet_normal)> [layout.json 경로]
 - <접두>.csv           : 열 rack_id,temp_c  (센서 앵커 Sensor_TEMP_IN이 들어 있는 칸의 온도. 우리 솔버가 읽는 칸과 같음)
 - <접두>_front_mean.csv: 랙 앞면 바로 앞 한 겹(칸 한 줄 x 높이 0~2 m)의 평균 온도
 - <접두>_summary.json  : 평균, 최대, 줄 끝/가운데, 랙 안 속도, 에너지 수지 등
"""
import json
import sys
from pathlib import Path

import numpy as np

run = Path(sys.argv[1]); prefix = Path(sys.argv[2])
layout = Path(sys.argv[3]) if len(sys.argv) > 3 else (run / "case_layout.json" if (run / "case_layout.json").exists() else Path(__file__).resolve().parent / "layout.json")
hall = json.loads(layout.read_text(encoding="utf-8"))
vox = np.load(run / "case_voxels.npz")
shape = tuple(int(v) for v in vox["shape"]); dx = float(vox["dx"])
solid = np.unpackbits(vox["solid"])[: int(np.prod(shape))].astype(bool).reshape(shape, order="F")
keep = ~solid
nx, ny, nz = shape


def latest():
    ts = [d for d in run.iterdir() if d.is_dir() and d.name.replace(".", "").isdigit() and d.name != "0"]
    return max(ts, key=lambda d: float(d.name))


def read_field(path, vector=False):
    lines = path.read_text().splitlines()
    for i, l in enumerate(lines):
        if l.startswith("internalField"):
            if "uniform" in l and "nonuniform" not in l:
                raise RuntimeError("uniform field: " + l)
            n = int(lines[i + 1])
            body = lines[i + 3: i + 3 + n]
            if vector:
                return np.array([[float(x) for x in b.strip("()").split()] for b in body])
            return np.array([float(b) for b in body])
    raise RuntimeError("internalField not found")


tdir = latest()
T = read_field(tdir / "T") - 273.15
U = read_field(tdir / "U", vector=True)
assert len(T) == int(keep.sum()), (len(T), int(keep.sum()))
kf = keep.ravel(order="F")                         # OpenFOAM 칸 순서: x가 가장 빠름(Fortran 순서)
Tf = np.full(kf.size, np.nan); Tf[kf] = T
Tg = Tf.reshape(shape, order="F")                  # (x, y, z) 칸 배열. 고체 칸은 NaN
Ug = np.full(shape + (3,), np.nan)
for c in range(3):
    Uf = np.full(kf.size, np.nan); Uf[kf] = U[:, c]
    Ug[..., c] = Uf.reshape(shape, order="F")

_meta0 = json.loads((run / "case_meta.json").read_text(encoding="utf-8")) if (run / "case_meta.json").exists() else {}
ZOFF = float(_meta0.get("z_off_cm") or 0.0)  # 이중 바닥이면 계산 좌표의 z가 바닥 아래 공간만큼 올라가 있다(docs/33)
anch = {a["equipment"]: (a["pos_cm"][0], a["pos_cm"][1], a["pos_cm"][2] + ZOFF) for a in hall["anchors"] if a["metric"] == "temp_in"}
racks = hall["racks"]
ids, t_anchor, t_front, v_rack, t_back = [], [], [], [], []
for r in racks:
    ax, ay, az = anch[r["name"]]
    i, j, k = int(ax / 100 / dx), int(ay / 100 / dx), int(az / 100 / dx)
    t_anchor.append(Tg[i, j, k])
    (x0, y0, z0), (x1, y1, z1) = r["min"], r["max"]
    axis, sign = r["front"]
    xs, xe = int(round(x0 / 100 / dx)), int(round(x1 / 100 / dx))
    ys, ye = int(round(y0 / 100 / dx)), int(round(y1 / 100 / dx))
    zs, ze = int(round(ZOFF / 100 / dx)), int(round((z1 + ZOFF) / 100 / dx))
    jf = ye if sign > 0 else ys - 1      # 앞면 바로 앞 칸 줄
    jb = ys - 1 if sign > 0 else ye      # 뒷면 바로 뒤 칸 줄
    t_front.append(np.nanmean(Tg[xs:xe, jf, zs:ze]))
    t_back.append(np.nanmean(Tg[xs:xe, jb, zs:ze]))
    v_rack.append(float(np.nanmean(-sign * Ug[xs:xe, ys:ye, zs:ze, 1])))
    ids.append(r["name"])
t_anchor = np.array(t_anchor); t_front = np.array(t_front); t_back = np.array(t_back); v_rack = np.array(v_rack)

prefix.parent.mkdir(parents=True, exist_ok=True)
Path(str(prefix) + ".csv").write_text("rack_id,temp_c\n" + "".join(f"{i},{t:.3f}\n" for i, t in zip(ids, t_anchor)), encoding="utf-8")
Path(str(prefix) + "_front_mean.csv").write_text("rack_id,temp_c\n" + "".join(f"{i},{t:.3f}\n" for i, t in zip(ids, t_front)), encoding="utf-8")

per_row = 10
pos = np.array([(int(i.split("_")[1]) - 1) % per_row for i in ids])  # 랙 이름 번호로 줄 안 위치를 구한다(랙을 뺀 배치도 처리)
end = (pos == 0) | (pos == per_row - 1); mid = ~end
meta = json.loads((run / "case_meta.json").read_text(encoding="utf-8"))
# 에너지 수지: CRAC 회수구 바로 앞 칸의 온도로 빠져나가는 열을 계산한다
out_kw = 0.0
for c in hall["cracs"]:
    q = meta["crac_return_m3s"][c["name"]]
    if q <= 0:
        continue
    (x0, y0, z0), (x1, y1, z1) = c["min"], c["max"]
    axis, sign = c["front"]
    ys, ye = int(round(y0 / 100 / dx)), int(round(y1 / 100 / dx))
    xs, xe = int(round(x0 / 100 / dx)), int(round(x1 / 100 / dx))
    xi = xe if sign > 0 else xs - 1
    tret = np.nanmean(Tg[xi, ys:ye, int((0.1 + ZOFF / 100) / dx):int((1.9 + ZOFF / 100) / dx)])
    out_kw += 1.2 * q * (tret - 18.0)
summary = {
    "result_time": tdir.name, "dx_m": dx,
    "rack_inlet_anchor_C": {"min": round(float(t_anchor.min()), 2), "mean": round(float(t_anchor.mean()), 2), "max": round(float(t_anchor.max()), 2),
                            "end_racks_mean": round(float(t_anchor[end].mean()), 2), "middle_racks_mean": round(float(t_anchor[mid].mean()), 2)},
    "rack_inlet_front_layer_mean_C": {"min": round(float(t_front.min()), 2), "mean": round(float(t_front.mean()), 2), "max": round(float(t_front.max()), 2),
                                      "end_racks_mean": round(float(t_front[end].mean()), 2), "middle_racks_mean": round(float(t_front[mid].mean()), 2)},
    "hottest_inlet_racks": [ids[i] for i in np.argsort(-t_anchor)[:5]],
    "rack_through_speed_ms": {"target": 0.8, "mean": round(float(v_rack.mean()), 3), "min": round(float(v_rack.min()), 3), "max": round(float(v_rack.max()), 3)},
    "rack_exhaust_front_to_back_rise_C_mean": round(float((t_back - t_front).mean()), 2),
    "energy_balance_kW": {"rack_heat_in": meta.get("total_power_kw", meta["power_kw"] * len(ids)), "carried_out_by_crac_returns": round(out_kw, 1)},
    "T_all_cells_C": {"min": round(float(np.nanmin(Tg)), 2), "max": round(float(np.nanmax(Tg)), 2)},
}
Path(str(prefix) + "_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=1))
