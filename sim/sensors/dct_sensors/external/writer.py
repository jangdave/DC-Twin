"""레거시 VTK 쓰기(시험과 `demo`용). 읽기(`vtk_legacy.py`)와 짝이 되는 최소 구현이다. 외부 도구의 출력을 흉내 내려는 것이 아니라
읽기 구현을 시험할 합성 파일을 만들려는 것이다."""
from __future__ import annotations

import numpy as np

TYPES = {"float": ">f4", "double": ">f8", "int": ">i4", "vtktypeint64": ">i8"}


def _block(a: np.ndarray, vtype: str, binary: bool, per_line: int = 6) -> bytes:
    flat = np.asarray(a).ravel()
    if binary:
        return flat.astype(TYPES[vtype]).tobytes() + b"\n"
    fmt = "%d" if vtype in ("int", "vtktypeint64") else "%.9g"
    rows = [" ".join(fmt % v for v in flat[i:i + per_line]) for i in range(0, len(flat), per_line)]
    return ("\n".join(rows) + "\n").encode()


def _header(kind: str, binary: bool, title: str) -> bytes:
    return f"# vtk DataFile Version 3.0\n{title}\n{'BINARY' if binary else 'ASCII'}\nDATASET {kind}\n".encode()


def structured_points(dims, origin, spacing, point_scalars: dict[str, np.ndarray], binary=False, title="synthetic") -> bytes:
    n = dims[0] * dims[1] * dims[2]
    out = _header("STRUCTURED_POINTS", binary, title)
    out += f"DIMENSIONS {dims[0]} {dims[1]} {dims[2]}\nORIGIN {origin[0]} {origin[1]} {origin[2]}\nSPACING {spacing[0]} {spacing[1]} {spacing[2]}\n".encode()
    out += f"POINT_DATA {n}\n".encode()
    for name, a in point_scalars.items():
        out += f"SCALARS {name} float 1\nLOOKUP_TABLE default\n".encode() + _block(a, "float", binary)
    return out


def rectilinear_grid(xs, ys, zs, point_scalars: dict[str, np.ndarray], binary=False) -> bytes:
    out = _header("RECTILINEAR_GRID", binary, "synthetic")
    out += f"DIMENSIONS {len(xs)} {len(ys)} {len(zs)}\n".encode()
    for tag, c in (("X", xs), ("Y", ys), ("Z", zs)):
        out += f"{tag}_COORDINATES {len(c)} float\n".encode() + _block(np.asarray(c), "float", binary)
    out += f"POINT_DATA {len(xs) * len(ys) * len(zs)}\n".encode()
    for name, a in point_scalars.items():
        out += f"SCALARS {name} float 1\nLOOKUP_TABLE default\n".encode() + _block(a, "float", binary)
    return out


def unstructured_hexes(points: np.ndarray, hexes: np.ndarray, cell_scalars: dict[str, np.ndarray] | None = None, point_scalars: dict[str, np.ndarray] | None = None,
                       binary=False, new_style=False) -> bytes:
    """육면체(VTK 종류 12) 셀로 된 UNSTRUCTURED_GRID. OpenFOAM foamToVTK가 내는 모양(CELL_DATA에 T)을 흉내 낸다."""
    nc = len(hexes)
    out = _header("UNSTRUCTURED_GRID", binary, "synthetic")
    out += f"POINTS {len(points)} float\n".encode() + _block(points, "float", binary)
    if new_style:
        offsets = np.arange(0, 8 * (nc + 1), 8)
        out += f"CELLS {nc + 1} {8 * nc}\nOFFSETS vtktypeint64\n".encode() + _block(offsets, "vtktypeint64", binary)
        out += b"CONNECTIVITY vtktypeint64\n" + _block(hexes, "vtktypeint64", binary)
    else:
        flat = np.concatenate([np.full((nc, 1), 8), hexes], axis=1)
        out += f"CELLS {nc} {9 * nc}\n".encode() + _block(flat, "int", binary)
    out += f"CELL_TYPES {nc}\n".encode() + _block(np.full(nc, 12), "int", binary)
    if cell_scalars:
        out += f"CELL_DATA {nc}\n".encode()
        for name, a in cell_scalars.items():
            out += f"SCALARS {name} float 1\nLOOKUP_TABLE default\n".encode() + _block(a, "float", binary)
    if point_scalars:
        out += f"POINT_DATA {len(points)}\n".encode()
        for name, a in point_scalars.items():
            out += f"SCALARS {name} float 1\nLOOKUP_TABLE default\n".encode() + _block(a, "float", binary)
    return out


def box_hex_mesh(nx: int, ny: int, nz: int, size: tuple[float, float, float]):
    """상자를 nx x ny x nz 육면체로 나눈 점과 셀. 시험용."""
    xs, ys, zs = (np.linspace(0, size[k], n + 1) for k, n in enumerate((nx, ny, nz)))
    gz, gy, gx = np.meshgrid(zs, ys, xs, indexing="ij")
    pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    pid = lambda i, j, k: (k * (ny + 1) + j) * (nx + 1) + i  # noqa: E731
    cells = []
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                cells.append([pid(i, j, k), pid(i + 1, j, k), pid(i + 1, j + 1, k), pid(i, j + 1, k), pid(i, j, k + 1), pid(i + 1, j, k + 1), pid(i + 1, j + 1, k + 1), pid(i, j + 1, k + 1)])
    return pts, np.array(cells)
