"""레거시 VTK(`.vtk`) 읽기. 외부 CFD 도구가 내보내는 결과를 우리 격자로 옮기려고 만든 최소 구현이다(numpy만 쓴다).

지원: ASCII와 BINARY(빅 엔디언), STRUCTURED_POINTS, RECTILINEAR_GRID, STRUCTURED_GRID, UNSTRUCTURED_GRID,
POINT_DATA와 CELL_DATA의 SCALARS, VECTORS, FIELD. 연결 정보(CELLS)는 옛 형식과 5.1 형식(OFFSETS, CONNECTIVITY)을 둘 다 읽는다.
지원하지 않음: XML 형식(.vtu, .vti), POLYDATA(점만 있는 경우 제외), `bit` 자료형, 압축.

주의: 실제 외부 도구의 파일로는 시험하지 못했다. 시험은 이 모듈이 직접 만든 합성 파일과 OpenFOAM `foamToVTK` 형태(UNSTRUCTURED_GRID, CELL_DATA)를
흉내 낸 파일로 한다. 처음 쓰는 파일은 `python -m dct_sensors.external inspect <파일>`로 구조를 먼저 본다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

DTYPES = {
    "float": ">f4", "double": ">f8", "int": ">i4", "unsigned_int": ">u4", "long": ">i8", "unsigned_long": ">u8",
    "short": ">i2", "unsigned_short": ">u2", "char": ">i1", "unsigned_char": ">u1", "vtktypeint64": ">i8", "vtktypeuint64": ">u8",
    "vtkidtype": ">i8", "int64": ">i8", "int32": ">i4",
}
# VTK 셀 종류(꼭짓점 수가 고정인 것). 가변인 것(POLYGON 등)은 연결 정보의 개수를 쓴다.
SKIP_TOKENS = {"METADATA"}


class VtkError(ValueError):
    """읽을 수 없는 파일. 메시지는 사용자에게 그대로 보여 줘도 된다."""


@dataclass
class Dataset:
    kind: str                                  # STRUCTURED_POINTS 등
    binary: bool
    dims: tuple[int, int, int] | None = None
    points: np.ndarray | None = None           # (N,3) 점 좌표. STRUCTURED_POINTS와 RECTILINEAR_GRID도 풀어서 채운다
    cells: list[np.ndarray] | None = None      # UNSTRUCTURED_GRID의 셀별 꼭짓점 번호
    point_data: dict[str, np.ndarray] = field(default_factory=dict)
    cell_data: dict[str, np.ndarray] = field(default_factory=dict)
    title: str = ""

    @property
    def n_points(self) -> int:
        return 0 if self.points is None else len(self.points)

    def cell_centers(self) -> np.ndarray:
        """셀 중심(꼭짓점 평균). 셀 값을 점처럼 다루려고 쓴다."""
        if self.cells is None or self.points is None:
            raise VtkError("셀 중심을 구할 수 없다: 셀 정보가 없는 데이터셋이다")
        return np.array([self.points[c].mean(axis=0) for c in self.cells])

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        if self.points is None or len(self.points) == 0:
            raise VtkError("점이 없다")
        return self.points.min(axis=0), self.points.max(axis=0)


class _Reader:
    def __init__(self, data: bytes):
        self.d, self.i = data, 0

    def line(self) -> str:
        j = self.d.find(b"\n", self.i)
        if j < 0:
            j = len(self.d)
        s = self.d[self.i:j].decode("latin-1").strip()
        self.i = min(j + 1, len(self.d))
        return s

    def peek_token(self) -> str:
        k = self.i
        while k < len(self.d) and self.d[k:k + 1].isspace():
            k += 1
        m = k
        while m < len(self.d) and not self.d[m:m + 1].isspace():
            m += 1
        return self.d[k:m].decode("latin-1")

    def skip_ws(self) -> None:
        while self.i < len(self.d) and self.d[self.i:self.i + 1].isspace():
            self.i += 1

    def tokens(self, n: int) -> list[str]:
        out: list[str] = []
        while len(out) < n:
            self.skip_ws()
            if self.i >= len(self.d):
                raise VtkError("파일이 중간에 끝났다(값이 모자란다)")
            j = self.i
            while j < len(self.d) and not self.d[j:j + 1].isspace():
                j += 1
            out.append(self.d[self.i:j].decode("latin-1"))
            self.i = j
        return out

    def array(self, count: int, vtype: str, binary: bool) -> np.ndarray:
        dt = DTYPES.get(vtype.lower())
        if dt is None:
            raise VtkError(f"지원하지 않는 자료형: {vtype}")
        if binary:
            nbytes = count * np.dtype(dt).itemsize
            if self.i + nbytes > len(self.d):
                raise VtkError("파일이 중간에 끝났다(이진 값이 모자란다)")
            a = np.frombuffer(self.d, dtype=dt, count=count, offset=self.i).astype(np.float64 if "f" in dt else np.int64)
            self.i += nbytes
            return a
        return np.array(self.tokens(count), dtype=np.float64 if "f" in dt else np.int64)


def _regular_points(dims, origin, spacing) -> np.ndarray:
    nx, ny, nz = dims
    xs, ys, zs = (origin[k] + spacing[k] * np.arange(dims[k]) for k in range(3))
    return _tensor_points(xs, ys, zs)


def _tensor_points(xs, ys, zs) -> np.ndarray:
    # VTK는 x가 가장 빨리 변한다(x, y, z 순서)
    gz, gy, gx = np.meshgrid(zs, ys, xs, indexing="ij")
    return np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)


def parse(data: bytes) -> Dataset:
    r = _Reader(data)
    head = r.line()
    if not head.startswith("# vtk DataFile"):
        raise VtkError("레거시 VTK 파일이 아니다(첫 줄이 '# vtk DataFile'이 아님). XML 형식(.vtu, .vti)은 지원하지 않는다")
    title = r.line()
    mode = r.line().upper()
    if mode not in ("ASCII", "BINARY"):
        raise VtkError(f"ASCII나 BINARY여야 한다: {mode}")
    binary = mode == "BINARY"
    kw = r.line().split()
    if len(kw) != 2 or kw[0].upper() != "DATASET":
        raise VtkError("DATASET 줄이 없다")
    kind = kw[1].upper()
    if kind not in ("STRUCTURED_POINTS", "RECTILINEAR_GRID", "STRUCTURED_GRID", "UNSTRUCTURED_GRID"):
        raise VtkError(f"지원하지 않는 데이터셋: {kind} (STRUCTURED_POINTS, RECTILINEAR_GRID, STRUCTURED_GRID, UNSTRUCTURED_GRID만 읽는다)")
    ds = Dataset(kind=kind, binary=binary, title=title)
    origin, spacing = (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)
    coords: dict[str, np.ndarray] = {}
    section: str | None = None  # "point" | "cell"
    n_sec = 0
    while True:
        r.skip_ws()
        if r.i >= len(r.d):
            break
        tok = r.peek_token().upper()
        if tok in SKIP_TOKENS:
            raise VtkError("METADATA 구간은 지원하지 않는다")
        line = r.line()
        parts = line.split()
        if not parts:
            continue
        key = parts[0].upper()
        if key == "DIMENSIONS":
            ds.dims = (int(parts[1]), int(parts[2]), int(parts[3]))
        elif key == "ORIGIN":
            origin = tuple(float(x) for x in parts[1:4])
        elif key in ("SPACING", "ASPECT_RATIO"):
            spacing = tuple(float(x) for x in parts[1:4])
        elif key in ("X_COORDINATES", "Y_COORDINATES", "Z_COORDINATES"):
            coords[key[0]] = r.array(int(parts[1]), parts[2], binary)
        elif key == "POINTS":
            ds.points = r.array(int(parts[1]) * 3, parts[2], binary).reshape(-1, 3).astype(np.float64)
        elif key == "CELLS":
            ncell, size = int(parts[1]), int(parts[2])
            if r.peek_token().upper() == "OFFSETS":  # 5.1 형식: OFFSETS, CONNECTIVITY
                o = r.line().split()
                offsets = r.array(ncell, o[1], binary)  # 5.1 형식의 CELLS 첫 수는 "셀 수 + 1"(오프셋 개수)이다
                r.skip_ws()  # 값 목록 끝의 줄바꿈을 건너뛴다
                c = r.line().split()
                if not c or c[0].upper() != "CONNECTIVITY":
                    raise VtkError("OFFSETS 다음에 CONNECTIVITY가 없다")
                conn = r.array(size, c[1], binary)
                ds.cells = [conn[offsets[k]:offsets[k + 1]] for k in range(ncell - 1)]
            else:
                flat = r.array(size, "int", binary)
                cells, k = [], 0
                for _ in range(ncell):
                    n = int(flat[k])
                    cells.append(flat[k + 1:k + 1 + n])
                    k += n + 1
                ds.cells = cells
        elif key == "CELL_TYPES":
            r.array(int(parts[1]), "int", binary)  # 종류는 쓰지 않는다(중심은 꼭짓점 평균)
        elif key == "POINT_DATA":
            section, n_sec = "point", int(parts[1])
        elif key == "CELL_DATA":
            section, n_sec = "cell", int(parts[1])
        elif key == "SCALARS":
            name, vtype = parts[1], parts[2]
            ncomp = int(parts[3]) if len(parts) > 3 else 1
            nxt = r.peek_token().upper()
            if nxt == "LOOKUP_TABLE":
                r.line()
            a = r.array(n_sec * ncomp, vtype, binary)
            _put(ds, section, name, a.reshape(n_sec, ncomp) if ncomp > 1 else a)
        elif key == "VECTORS" or key == "NORMALS":
            a = r.array(n_sec * 3, parts[2], binary).reshape(n_sec, 3)
            _put(ds, section, parts[1], a)
        elif key == "FIELD":
            for _ in range(int(parts[2])):
                f = r.line().split()
                ncomp, ntup, vtype = int(f[1]), int(f[2]), f[3]
                a = r.array(ncomp * ntup, vtype, binary)
                _put(ds, section, f[0], a.reshape(ntup, ncomp) if ncomp > 1 else a)
        elif key in ("LOOKUP_TABLE", "COLOR_SCALARS", "TENSORS", "TEXTURE_COORDINATES"):
            raise VtkError(f"지원하지 않는 구간: {key}")
        else:
            raise VtkError(f"알 수 없는 줄: {line[:40]}")
    # 정규 격자는 점 좌표를 풀어 둔다(찾기가 쉽도록)
    if kind == "STRUCTURED_POINTS":
        if ds.dims is None:
            raise VtkError("DIMENSIONS가 없다")
        ds.points = _regular_points(ds.dims, origin, spacing)
    elif kind == "RECTILINEAR_GRID":
        if ds.dims is None or set(coords) != {"X", "Y", "Z"}:
            raise VtkError("RECTILINEAR_GRID에 DIMENSIONS나 좌표가 없다")
        ds.points = _tensor_points(coords["X"], coords["Y"], coords["Z"])
    if ds.points is None:
        raise VtkError("점 좌표가 없다")
    return ds


def _put(ds: Dataset, section: str | None, name: str, a: np.ndarray) -> None:
    if section == "point":
        ds.point_data[name] = a
    elif section == "cell":
        ds.cell_data[name] = a
    else:
        raise VtkError(f"POINT_DATA나 CELL_DATA 없이 값이 나왔다: {name}")


def read(path) -> Dataset:
    with open(path, "rb") as f:
        return parse(f.read())


def describe(ds: Dataset) -> str:
    lo, hi = ds.bounds()
    lines = [f"데이터셋: {ds.kind} ({'BINARY' if ds.binary else 'ASCII'}) 제목: {ds.title!r}",
             f"점 {ds.n_points}개" + (f", 셀 {len(ds.cells)}개" if ds.cells is not None else "") + (f", 격자 {ds.dims}" if ds.dims else ""),
             f"좌표 범위: x {lo[0]:.4g}~{hi[0]:.4g}, y {lo[1]:.4g}~{hi[1]:.4g}, z {lo[2]:.4g}~{hi[2]:.4g}  (단위는 파일에 없다. mapping의 unit으로 알려 준다)"]
    for label, d in (("점 값", ds.point_data), ("셀 값", ds.cell_data)):
        for k, a in d.items():
            comp = 1 if a.ndim == 1 else a.shape[1]
            lines.append(f"{label} {k}: 성분 {comp}, 범위 {a.min():.4g}~{a.max():.4g}")
    return "\n".join(lines)
