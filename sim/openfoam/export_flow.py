"""OpenFOAM 결과(마지막 시각)의 속도와 온도를 우리 격자 배열로 저장한다. WSL의 python3(numpy)로 실행한다 (V4-2, docs/32).

우리 열 계산이 OpenFOAM의 공기 흐름을 받아 온도만 다시 풀 수 있게 한다(`hall60_sim.Sim.set_flow_field`).
메시 칸 순서는 extract.py와 같다(한 덩어리 격자에서 고체 칸만 뺀 순서, x가 가장 빠름).

사용: python3 export_flow.py <실행 폴더> <출력 .npz>
결과: U (nx, ny, nz, 3) float32 m/s, T (nx, ny, nz) float32 도, nut (nx, ny, nz) float32 m2/s(난류 점성), solid (nx, ny, nz) bool(OpenFOAM에서 뺀 칸), dx, time
"""
import sys
from pathlib import Path

import numpy as np

run = Path(sys.argv[1])
out = Path(sys.argv[2])
vox = np.load(run / "case_voxels.npz")
shape = tuple(int(v) for v in vox["shape"])
dx = float(vox["dx"])
solid = np.unpackbits(vox["solid"])[: int(np.prod(shape))].astype(bool).reshape(shape, order="F")
keep = ~solid


def latest():
    ts = [d for d in run.iterdir() if d.is_dir() and d.name.replace(".", "").isdigit() and d.name != "0"]
    return max(ts, key=lambda d: float(d.name))


def read_field(path, vector=False):
    lines = path.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("internalField"):
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
kf = keep.ravel(order="F")
Tf = np.zeros(kf.size, dtype=np.float32)
Tf[kf] = T
Ug = np.zeros(shape + (3,), dtype=np.float32)
for c in range(3):
    uf = np.zeros(kf.size, dtype=np.float32)
    uf[kf] = U[:, c]
    Ug[..., c] = uf.reshape(shape, order="F")
out.parent.mkdir(parents=True, exist_ok=True)
nf = np.zeros(kf.size, dtype=np.float32)
nf[kf] = read_field(tdir / "nut")
np.savez_compressed(out, U=Ug, T=Tf.reshape(shape, order="F"), nut=nf.reshape(shape, order="F"), solid=solid, dx=dx, time=float(tdir.name))
print(f"{run.name}: 시각 {tdir.name}, 칸 {int(keep.sum())}, 최대 속도 {float(np.abs(U).max()):.2f} m/s -> {out}")
