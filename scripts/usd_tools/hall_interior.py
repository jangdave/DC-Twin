"""홀 장면의 형상(외피, 격벽, 급기구, 조명, 바닥 표시)을 재질과 UV가 있는 Mesh로 만든다. `build_scene.py`가 부른다.

- 길이 단위 cm, 바닥 윗면 z=0. 모든 메시는 단면(doubleSided=False)이고 반투명 유리(격벽 패널)만 양면이다.
- 재질은 `/DC/Hall01/Looks` 아래에 UsdPreviewSurface로 만든다. 텍스처는 장면 파일 기준 상대 경로(`../assets/textures/hall/`).
  텍스처 파일은 Git에 없다(docs/10_modeling_guide.md 12장으로 준비한다). 없으면 재질의 기본 색만 보인다.
- 텍스처 실제 크기(cm)는 `blender/textures/cc0_sources_hall.json`, `blender/scripts/make_hall_textures.py`와 같다.
- 시뮬레이션이 읽는 것(경로, 이름, dct:assetType, 경계 상자)은 이전 Cube 버전과 같다.
"""
from __future__ import annotations

from pathlib import Path

from pxr import Gf, Sdf, UsdGeom, UsdShade, Vt

# --- 텍스처 실제 크기(cm) -----------------------------------------------------------
FLOOR_TILE = 480.0       # T_HallFloor: 한 장에 타일 8 x 8장(타일 60 cm)
FLOOR_ORIGIN = (10.0, 40.0)  # 타일 이음선이 (x0 = 250, 첫 줄 y = 100)의 랙 모서리와 맞도록 정한 시작점
DOOR_H = 210.0  # 열기 통로 끝 미닫이 문 높이(cm). 그 위 ~ 칸막이 천장은 고정 판(천장 회수 장면, docs/35)
LIGHT_GAP = 3.0  # 열기 통로 조명과 격벽 지붕 사이 틈(cm)
WALL_TILE = (400.0, 200.0)   # T_HallWall: 4096 x 2048 픽셀
CEIL_TILE = 360.0        # T_HallCeiling: 한 장에 타일 6 x 6장(60 cm)
HAZARD_TILE = 40.0       # T_HallHazard
VENT_SIZE = (50.0, 100.0)  # T_VentTile: 급기구 한 장


class MeshB:
    """면을 모아 Mesh 하나로 쓰는 도우미. 점은 면마다 따로 둔다(법선, UV를 모서리마다 정하기 쉽다)."""

    def __init__(self) -> None:
        self.pts: list[tuple[float, float, float]] = []
        self.counts: list[int] = []
        self.uv: list[tuple[float, float]] = []
        self.nrm: list[tuple[float, float, float]] = []
        self.mat: list[str] = []

    def quad(self, p4, normal, mat, uvf) -> None:
        self.pts.extend(p4)
        self.counts.append(4)
        self.nrm.extend([normal] * 4)
        self.mat.append(mat)
        ax = max(range(3), key=lambda i: abs(normal[i]))
        for p in p4:
            self.uv.append(uvf(ax, normal[ax] > 0, p))

    def box(self, lo, hi, mat, uvf=None, skip=(), uvfs=None) -> None:
        """축 정렬 상자. 면마다 바깥이 앞면이 되도록 시계 반대 방향 순서. skip: '+x' 같은 면 이름. uvfs: {면 이름: uv 함수}."""
        lx, ly, lz = lo
        hx, hy, hz = hi
        f = uvf or planar(100.0)
        faces = {
            "+x": ([(hx, ly, lz), (hx, hy, lz), (hx, hy, hz), (hx, ly, hz)], (1, 0, 0)),
            "-x": ([(lx, ly, lz), (lx, ly, hz), (lx, hy, hz), (lx, hy, lz)], (-1, 0, 0)),
            "+y": ([(lx, hy, lz), (lx, hy, hz), (hx, hy, hz), (hx, hy, lz)], (0, 1, 0)),
            "-y": ([(lx, ly, lz), (hx, ly, lz), (hx, ly, hz), (lx, ly, hz)], (0, -1, 0)),
            "+z": ([(lx, ly, hz), (hx, ly, hz), (hx, hy, hz), (lx, hy, hz)], (0, 0, 1)),
            "-z": ([(lx, ly, lz), (lx, hy, lz), (hx, hy, lz), (hx, ly, lz)], (0, 0, -1)),
        }
        for name, (p4, n) in faces.items():
            if name in skip:
                continue
            m = mat[name] if isinstance(mat, dict) else mat
            self.quad(p4, n, m, (uvfs or {}).get(name, f))

    def triangles(self) -> int:
        return sum(c - 2 for c in self.counts)


def planar(ts, off=(0.0, 0.0, 0.0)):
    """면의 큰 방향 기준 평면 투영. 길이(cm) / 타일 크기. ts는 숫자 또는 (가로, 세로)."""
    tu, tv = (ts, ts) if isinstance(ts, (int, float)) else ts

    def f(ax, positive, p):
        q = (p[0] + off[0], p[1] + off[1], p[2] + off[2])
        a, b = {0: (q[1], q[2]), 1: (q[0], q[2]), 2: (q[0], q[1])}[ax]
        if ax == 0 and not positive:  # 바깥에서 봤을 때 글자가 뒤집히지 않도록 가로 방향 맞춤
            a = -a
        if ax == 1 and positive:
            a = -a
        return (a / tu, b / tv)

    return f


def author_mesh(stage, path: str, mb: MeshB, mats: dict, asset_type: str | None = None, double_sided: bool = False) -> UsdGeom.Mesh:
    mesh = UsdGeom.Mesh.Define(stage, path)
    pts = [Gf.Vec3f(*p) for p in mb.pts]
    mesh.GetPointsAttr().Set(Vt.Vec3fArray(pts))
    mesh.GetFaceVertexCountsAttr().Set(Vt.IntArray(mb.counts))
    idx, off = [], 0
    for c in mb.counts:
        idx.extend(range(off, off + c))
        off += c
    mesh.GetFaceVertexIndicesAttr().Set(Vt.IntArray(idx))
    mesh.GetNormalsAttr().Set(Vt.Vec3fArray([Gf.Vec3f(*n) for n in mb.nrm]))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.faceVarying)
    pv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
    pv.Set(Vt.Vec2fArray([Gf.Vec2f(*u) for u in mb.uv]))
    mesh.GetSubdivisionSchemeAttr().Set(UsdGeom.Tokens.none)
    mesh.GetDoubleSidedAttr().Set(double_sided)
    lo = [min(p[i] for p in mb.pts) for i in range(3)]
    hi = [max(p[i] for p in mb.pts) for i in range(3)]
    mesh.GetExtentAttr().Set(Vt.Vec3fArray([Gf.Vec3f(*lo), Gf.Vec3f(*hi)]))
    names = list(dict.fromkeys(mb.mat))
    if len(names) == 1:
        UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mats[names[0]])
    else:
        UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim())
        for n in names:
            sub = UsdGeom.Subset.CreateGeomSubset(mesh, n, UsdGeom.Tokens.face, Vt.IntArray([i for i, m in enumerate(mb.mat) if m == n]), "materialBind", UsdGeom.Tokens.nonOverlapping)
            UsdShade.MaterialBindingAPI.Apply(sub.GetPrim()).Bind(mats[n])
    if asset_type:
        mesh.GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set(asset_type)
    return mesh


# --- 재질 -----------------------------------------------------------------------
def _tex(stage, mat_path: str, name: str, file: str, srgb: bool, normal: bool = False):
    t = UsdShade.Shader.Define(stage, f"{mat_path}/{name}")
    t.CreateIdAttr("UsdUVTexture")
    t.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file))
    t.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB" if srgb else "raw")
    t.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
    t.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
    if normal:
        t.CreateInput("scale", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(2, 2, 2, 2))
        t.CreateInput("bias", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(-1, -1, -1, -1))
    return t


def make_material(stage, looks: str, name: str, color=(0.5, 0.5, 0.5), roughness=0.5, metallic=0.0, tex_dir: str | None = None,
                  prefix: str | None = None, ext: str = "png", metal_map: bool = False, emissive=None, opacity: float | None = None,
                  normal: bool = True) -> UsdShade.Material:
    """UsdPreviewSurface 재질. prefix가 있으면 `<tex_dir>/<prefix>_{BaseColor,Normal,Roughness[,Metallic]}.<ext>`를 연결한다."""
    mpath = f"{looks}/{name}"
    mat = UsdShade.Material.Define(stage, mpath)
    sh = UsdShade.Shader.Define(stage, f"{mpath}/Surface")
    sh.CreateIdAttr("UsdPreviewSurface")
    out = sh.CreateOutput("surface", Sdf.ValueTypeNames.Token)
    mat.CreateSurfaceOutput().ConnectToSource(out)
    sh.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(roughness)
    sh.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(metallic)
    if opacity is not None:
        sh.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(opacity)
    if emissive is not None:
        sh.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emissive))
    if prefix is None:
        sh.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
        return mat
    reader = UsdShade.Shader.Define(stage, f"{mpath}/st")
    reader.CreateIdAttr("UsdPrimvarReader_float2")
    reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
    st_out = reader.CreateOutput("result", Sdf.ValueTypeNames.Float2)

    def link(tex, out_name, typ):
        tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st_out)
        return tex.CreateOutput(out_name, typ)

    def f(kind, e=None):
        return f"{tex_dir}/{prefix}_{kind}.{e or ext}"

    base = _tex(stage, mpath, "BaseColor", f("BaseColor"), True)
    sh.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(link(base, "rgb", Sdf.ValueTypeNames.Float3))
    rough = _tex(stage, mpath, "Roughness", f("Roughness"), False)
    sh.GetInput("roughness").ConnectToSource(link(rough, "r", Sdf.ValueTypeNames.Float))
    if normal:
        nrm = _tex(stage, mpath, "Normal", f("Normal"), False, normal=True)
        sh.CreateInput("normal", Sdf.ValueTypeNames.Normal3f).ConnectToSource(link(nrm, "rgb", Sdf.ValueTypeNames.Float3))
    if metal_map:
        met = _tex(stage, mpath, "Metallic", f("Metallic"), False)
        sh.GetInput("metallic").ConnectToSource(link(met, "r", Sdf.ValueTypeNames.Float))
    return mat


def define_materials(stage, looks: str, tex_dir: str) -> dict:
    UsdGeom.Scope.Define(stage, looks)
    M = lambda *a, **k: make_material(stage, looks, *a, **k)  # noqa: E731
    return {
        "floor": M("M_HallFloor", roughness=0.35, tex_dir=tex_dir, prefix="T_HallFloor", ext="jpg"),
        "slab": M("M_HallSlab", color=(0.32, 0.32, 0.33), roughness=0.9),
        "wall": M("M_HallWall", roughness=0.8, tex_dir=tex_dir, prefix="T_HallWall", ext="jpg"),
        "ceiling": M("M_HallCeiling", roughness=0.8, tex_dir=tex_dir, prefix="T_HallCeiling", ext="jpg"),
        "skirting": M("M_HallSkirting", color=(0.22, 0.23, 0.25), roughness=0.6),
        "hazard": M("M_HallHazard", roughness=0.55, tex_dir=tex_dir, prefix="T_HallHazard", ext="png", normal=False),
        "line": M("M_HallLine", color=(0.80, 0.60, 0.03), roughness=0.55),
        "vent": M("M_VentTile", roughness=0.5, metallic=0.6, tex_dir=tex_dir, prefix="T_VentTile", ext="png"),
        "light_panel": M("M_LightPanel", color=(0.95, 0.95, 0.92), roughness=0.4, emissive=(4.0, 3.9, 3.6)),
        "light_frame": M("M_LightFrame", color=(0.75, 0.76, 0.78), roughness=0.4, metallic=0.6),
        "frame": M("M_ContainFrame", color=(0.55, 0.60, 0.66), roughness=0.35, metallic=0.85),
        "door": M("M_HallDoor", roughness=0.45, metallic=0.3, tex_dir=tex_dir, prefix="T_CracPaint"),  # 도장 철판(docs/35)
        "fire_pipe": M("M_FirePipe", color=(0.70, 0.08, 0.06), roughness=0.45, metallic=0.3),
        "detector": M("M_Detector", color=(0.90, 0.90, 0.88), roughness=0.6),
        "grommet": M("M_Grommet", color=(0.04, 0.04, 0.045), roughness=0.9),
        "rpp_body": M("M_RppBody", roughness=0.45, metallic=0.3, tex_dir=tex_dir, prefix="T_CracPaint"),
        "rpp_front": M("M_RppFront", roughness=0.5, metallic=0.3, tex_dir=tex_dir, prefix="T_RppPanel"),  # 차단기 창, 손잡이, 통풍 살(UV 0~1 한 번)
        "rpp_display": M("M_RppDisplay", color=(0.10, 0.80, 0.60), roughness=0.3, emissive=(0.05, 0.45, 0.34)),
        "grille": M("M_CeilingGrille", roughness=0.4, metallic=0.6, tex_dir=tex_dir, prefix="T_EggCrate"),  # 알루미늄 격자, 60 cm 한 장
        "glass": M("M_ContainGlass", color=(0.35, 0.60, 0.85), roughness=0.08, opacity=0.22),
    }


# --- 형상 -----------------------------------------------------------------------
def _floor_uv(ax, positive, p):
    return ((p[0] - FLOOR_ORIGIN[0]) / FLOOR_TILE, (p[1] - FLOOR_ORIGIN[1]) / FLOOR_TILE)


def _ceil_uv(ax, positive, p):
    return ((p[0] - FLOOR_ORIGIN[0]) / CEIL_TILE, (p[1] - FLOOR_ORIGIN[1]) / CEIL_TILE)


def build_shell(stage, shell: str, lay, cfg: dict, mats: dict) -> dict:
    """바닥, 벽 4개, 천장, 걸레받이, 바닥 표시, 조명. 삼각형 수를 이름별로 돌려준다."""
    ft, wt = cfg["hall"]["floor_thickness"], cfg["hall"]["wall_thickness"]
    W, L, H = lay.width, lay.length, lay.height
    tri: dict[str, int] = {}

    def put(name, mb, asset="shell", **kw):
        author_mesh(stage, f"{shell}/{name}", mb, mats, asset, **kw)
        tri[name] = mb.triangles()

    # 바닥: 윗면은 타일 텍스처(이음선은 텍스처에 있고 형상에는 틈을 만들지 않는다), 옆과 아랫면은 단색
    mb = MeshB()
    mb.box((-wt, -wt, -ft), (W + wt, L + wt, 0), {"+z": "floor", "-z": "slab", "+x": "slab", "-x": "slab", "+y": "slab", "-y": "slab"}, uvfs={"+z": _floor_uv})
    put("Floor", mb)
    # 벽: 안쪽 면(홀 쪽)에 도장 회벽. 가로는 4 m, 세로는 2 m 한 장
    wall_uv = planar(WALL_TILE)
    for name, lo, hi in (
        ("Wall_West", (-wt, -wt, 0), (0, L + wt, H)),
        ("Wall_East", (W, -wt, 0), (W + wt, L + wt, H)),
        ("Wall_South", (0, -wt, 0), (W, 0, H)),
        ("Wall_North", (0, L, 0), (W, L + wt, H)),
    ):
        mb = MeshB()
        mb.box(lo, hi, "wall", wall_uv)
        put(name, mb)
    # 천장: 아랫면에 천장 타일과 격자 텍스처(격자는 텍스처에 있다)
    mb = MeshB()
    mb.box((-wt, -wt, H), (W + wt, L + wt, H + wt), {k: "ceiling" for k in ("+x", "-x", "+y", "-y", "+z", "-z")}, uvfs={"-z": _ceil_uv})
    put("Ceiling", mb)
    # 걸레받이(높이 8 cm, 두께 1.2 cm). 모서리에서 서로 겹치지 않게 동서쪽 띠는 남북쪽 띠 사이에만 둔다
    sk, sh = 1.2, 8.0
    mb = MeshB()
    mb.box((0, 0, 0), (W, sk, sh), "skirting", planar(100.0), skip=("-z", "-y"))
    mb.box((0, L - sk, 0), (W, L, sh), "skirting", planar(100.0), skip=("-z", "+y"))
    mb.box((0, sk, 0), (sk, L - sk, sh), "skirting", planar(100.0), skip=("-z", "-x"))
    mb.box((W - sk, sk, 0), (W, L - sk, sh), "skirting", planar(100.0), skip=("-z", "+x"))
    put("Skirting", mb)

    # 바닥 표시: 두께 0.6 cm 판(윗면 z=0.6, 바닥 윗면과 0.5 cm보다 떨어져 깜빡이지 않는다)
    th = 0.6
    line = MeshB()
    for (ya, yb) in lay.cold_aisles:  # 냉기 통로 양쪽 노란 선(폭 5 cm, 랙 앞면에서 2 cm 안쪽)
        for y0 in (ya + 2.0, yb - 7.0):
            line.box((lay.rack_x0, y0, 0), (lay.rack_x1, y0 + 5.0, th), "line", planar(100.0), skip=("-z",))
    put("Floor_Markings_Line", line)
    haz = MeshB()
    ca, cw = cfg["crac"]["depth"], cfg["crac"]["width"]
    for yc in crac_ys(lay, cfg):  # CRAC 앞 점검 공간 표시(노랑-검정 줄무늬, 깊이 12 cm)
        for x0 in (ca, W - ca - 12.0):
            haz.box((x0, yc - cw / 2 + 5.0, 0), (x0 + 12.0, yc + cw / 2 - 5.0, th), "hazard", planar(HAZARD_TILE), skip=("-z",))
    put("Floor_Markings_Hazard", haz)

    tri.update(build_shell_extras(stage, shell, lay, cfg, mats))

    # 조명: 발광 재질 패널(광원 prim 없음. 실제 빛은 Unreal이 따로 둔다). 냉기 통로 위(천장 아래)와 열기 통로 위(격벽 지붕 아래)
    lights = f"{shell}/Lights"
    UsdGeom.Xform.Define(stage, lights).GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set("shell")
    n = 0
    nl = int((W - 200.0) // 150.0) + 1  # 조명 줄 간격 150 cm, 홀 가운데에 맞춘다
    xs = [(W - 150.0 * (nl - 1)) / 2 + 150.0 * k for k in range(nl)]
    rz = cfg["containment"]["roof_z"]
    ceil = ceiling_mode(cfg)
    if ceil:
        # 천장 회수 방식: 조명은 칸막이 천장(Z)에 붙이고, 열기 통로 위 천장에는 회수 그릴을 둔다(계산에서는 열린 칸)
        Z = ceiling_z(cfg)
        rz, H = Z + LIGHT_GAP, Z
        gr = MeshB()
        for (ya, yb) in lay.hot_aisles:
            gr.box((lay.rack_x0, ya, Z + 2.0), (lay.rack_x1, yb, Z + 2.6), "grille", planar(60.0))  # 격자판(T_EggCrate, 60 cm 한 장)
            k = 0
            while lay.rack_x0 + 15.0 * (k + 1) < lay.rack_x1:
                xg = lay.rack_x0 + 15.0 * (k + 1)
                gr.box((xg - 0.8, ya, Z), (xg + 0.8, yb, Z + 2.0), "grille", planar(100.0))
                k += 1
        put("Ceiling_ReturnGrille", gr)
    # 열기 통로 조명은 격벽 지붕 아래에 LIGHT_GAP만큼 띄워 매단다. 윗면이 지붕 아랫면과 같은 높이면 두 면이 겹쳐 깜빡인다(2026-11-11 사용자 보고).
    # 격벽 방식(containment.type): hot(열기 통로 격리, 기본)이면 열기 통로 조명이 격벽 지붕 아래, cold(냉기 통로 격리, CAC)이면 냉기 통로 조명이 격벽 지붕 아래다
    cold_cont = containment_type(cfg) == "cold"
    xs_in = [x for x in xs if lay.rack_x0 + 60.0 <= x <= lay.rack_x1 - 60.0]  # 격벽 지붕 안에 들어가는 자리만
    spots = [((y0 + y1) / 2, rz - LIGHT_GAP if cold_cont else H, 20.0, xs_in if cold_cont else xs) for (y0, y1) in lay.cold_aisles] +             [((y0 + y1) / 2, H if cold_cont else rz - LIGHT_GAP, 15.0, xs) for (y0, y1) in lay.hot_aisles]
    tri["Lights"] = 0
    for yc, ztop, w, xs_ in spots:
        for xc in xs_:
            n += 1
            p = f"{lights}/Light_{n:02d}"
            UsdGeom.Xform.Define(stage, p)
            fr = MeshB()
            fr.box((xc - 60.0, yc - w / 2, ztop - 3.0), (xc + 60.0, yc + w / 2, ztop), "light_frame", planar(100.0))
            author_mesh(stage, f"{p}/Frame", fr, mats)
            dif = MeshB()
            dif.box((xc - 57.0, yc - w / 2 + 3.0, ztop - 4.0), (xc + 57.0, yc + w / 2 - 3.0, ztop - 3.0), "light_panel", planar(100.0))
            author_mesh(stage, f"{p}/Diffuser", dif, mats)
            tri["Lights"] += fr.triangles() + dif.triangles()
    return tri


def build_shell_extras(stage, shell: str, lay, cfg: dict, mats: dict) -> dict:
    """화면용 홀 부속 설비(계산에는 넣지 않는다, docs/35): 홀 출입문, 격리 통로 안 스프링클러 배관과 헤드, 방 천장의 헤드와 연기 감지기,
    랙 뒤 바닥 케이블 구멍의 브러시 막음."""
    W, L = lay.width, lay.length
    tri: dict[str, int] = {}

    def put(name, mb):
        author_mesh(stage, f"{shell}/{name}", mb, mats, "shell")
        tri[name] = mb.triangles()

    # 홀 출입문(벽 안쪽 면에 2 cm 두께로 붙인다): 남쪽 벽 장비 반입용 양문(폭 180, 높이 240), 북쪽 벽 비상 출입문(폭 100, 높이 220)
    cd = cfg["crac"]["depth"]
    for wall, yw, sgn, x0, w, h, leaves in (("South", 0.0, 1, cd + 40.0, 180.0, 240.0, 2), ("North", L, -1, W - cd - 40.0 - 100.0, 100.0, 220.0, 1)):
        mb = MeshB()
        y0, y1 = (yw, yw + 2.0) if sgn > 0 else (yw - 2.0, yw)
        mb.box((x0 - 6.0, y0, 0), (x0, y1, h + 6.0), "door")  # 문틀
        mb.box((x0 + w, y0, 0), (x0 + w + 6.0, y1, h + 6.0), "door")
        mb.box((x0, y0, h), (x0 + w, y1, h + 6.0), "door")
        lw = w / leaves
        for k in range(leaves):
            xa = x0 + k * lw
            mb.box((xa + 0.5, y0, 0.5), (xa + lw - 0.5, y1, h - 0.5), "door")  # 문짝(틈 1 cm)
            xh = xa + lw - 12.0 if (leaves == 1 or k == 0) else xa + 8.0  # 손잡이(문짝이 만나는 쪽)
            hy0, hy1 = (y1, y1 + 4.0) if sgn > 0 else (y0 - 4.0, y0)
            mb.box((xh, hy0, 95.0), (xh + 4.0, hy1, 125.0), "grommet")
        put(f"Wall_{wall}_Door", mb)

    # 스프링클러: 열기 통로 격리(HAC)면 열기 통로 안 천장 아래 배관(6 cm 각관)과 헤드 240 cm 간격.
    # 냉기 통로 격리(CAC)는 지붕이 랙 높이(2 m)라 통로 안 배관이 사람 머리 높이에 걸린다. CAC 지붕은 열에 떨어지는 판으로 보고
    # 방 천장 헤드(아래 Fire_Ceiling_Devices)만 둔다(2026-11-17 사용자 지적 "CAC 이상한 부분")
    ceil = ceiling_mode(cfg)
    rz = cfg["containment"]["roof_z"]
    top = ceiling_z(cfg) if ceil else rz
    aisles = [] if containment_type(cfg) == "cold" else lay.hot_aisles
    pipe = MeshB()
    for (ya, yb) in aisles:
        yc = (ya + yb) / 2
        pipe.box((lay.rack_x0, yc - 3.0, top - 25.0), (lay.rack_x1, yc + 3.0, top - 19.0), "fire_pipe")
        x = lay.rack_x0 + 120.0
        while x < lay.rack_x1 - 60.0:
            pipe.box((x - 2.0, yc - 2.0, top - 33.0), (x + 2.0, yc + 2.0, top - 25.0), "fire_pipe")
            x += 240.0
    if aisles:
        put("Fire_Sprinkler_Aisle", pipe)
    # 방 천장(칸막이 천장이 있으면 그 아랫면): 헤드와 연기 감지기(냉기 통로와 줄 끝 통로 위)
    room_top = ceiling_z(cfg) if ceil else lay.height
    det = MeshB()
    spots = [((ya + yb) / 2, lay.rack_x0 + 60.0 + 240.0 * k) for (ya, yb) in lay.cold_aisles for k in range(3)]
    spots += [(lay.length * (k + 0.5) / 4, x) for k in range(4) for x in (cd + 120.0, W - cd - 120.0)]
    for yc, xc in spots:
        det.box((xc - 6.0, yc - 6.0, room_top - 4.0), (xc + 6.0, yc + 6.0, room_top), "detector")  # 연기 감지기
        det.box((xc + 60.0 - 2.0, yc - 2.0, room_top - 8.0), (xc + 60.0 + 2.0, yc + 2.0, room_top), "detector")  # 헤드(흰색 매립형)
    put("Fire_Ceiling_Devices", det)

    # 케이블 구멍 브러시 막음: 랙마다 뒤쪽(열기 통로 쪽) 바닥에 25 x 10 cm(계산은 원래 막힌 것으로 본다)
    gr = MeshB()
    rk = cfg["rack"]
    for i, y0 in enumerate(lay.row_y0):
        front_plus = lay.row_front_plus_y[i]
        yb = y0 - 12.0 if front_plus else y0 + rk["depth"] + 2.0  # 뒷면 바로 밖
        for n in range(cfg["rows"]["racks_per_row"]):
            xc = lay.rack_x0 + rk["width"] * (n + 0.5)
            gr.box((xc - 12.5, yb, 0.0), (xc + 12.5, yb + 10.0, 0.8), "grommet")
    put("Floor_Grommets", gr)
    return tri


def containment_type(cfg: dict) -> str:
    """격벽 방식. "hot": 열기 통로 격리(HAC, 기본), "cold": 냉기 통로 격리(CAC). docs/34"""
    t = cfg["containment"].get("type", "hot")
    if t not in ("hot", "cold"):
        raise ValueError(f"containment.type은 hot 또는 cold: {t}")
    return t


def hot_end(cfg: dict) -> str:
    """열기 통로 끝과 회수 방식(HAC만).
    "full": 격벽이 공조기 앞면까지 바닥부터 막는다(2026-11-16 이전, 설정에 값이 없으면 이것).
    "ceiling": 칸막이 천장 위를 공통 회수 공간(천장 플레넘)으로 쓴다. 열기 통로는 줄 끝 문과 랙 위 ~ 천장 옆판으로 막고,
    천장의 회수 그릴로 뜨거운 공기가 올라간다. 공조기는 윗면 흡입구에 붙인 연장 덕트로 회수 공간에서 빨아들인다(docs/35)."""
    t = cfg["containment"].get("hot_end", "full")
    if t not in ("full", "ceiling"):
        raise ValueError(f"containment.hot_end은 full 또는 ceiling: {t}")
    return t


def ceiling_mode(cfg: dict) -> bool:
    return containment_type(cfg) == "hot" and hot_end(cfg) == "ceiling"


def ceiling_z(cfg: dict) -> float:
    """칸막이 천장 아랫면 높이(cm, 바닥에서). 그 위 ~ 홀 천장(hall.ceiling_height)이 회수 공간이다."""
    return float(cfg["containment"].get("ceiling", {}).get("z", 320))


def crac_ys(lay, cfg: dict) -> list[float]:
    """한쪽 벽의 공조기 가운데 y 위치(열기 통로마다 하나). 열기 통로 가운데에 두되, 공조기 폭이 벽을 넘지 않게 안쪽으로 민다."""
    w = cfg["crac"]["width"]
    return [min(max((ya + yb) / 2, w / 2), lay.length - w / 2) for (ya, yb) in lay.hot_aisles]


def crac_return(cfg: dict) -> tuple[str, tuple[float, float]] | None:
    """공조기 회수구: (면, 높이 범위 cm). 설정 crac.return_face가 top이면 윗면 바로 위 두 층(20 cm).
    천장 회수 방식이면 연장 덕트 끝(칸막이 천장 윗면) 바로 위, 아니면 공조기 윗면 바로 위. front(기본)이면 None(계산 기본값)."""
    cr = cfg["crac"]
    if cr.get("return_face", "front") != "top":
        return None
    z0 = ceiling_z(cfg) + cfg["containment"]["panel_thickness"] if ceiling_mode(cfg) else float(cr["height"])
    return ("top", (z0, z0 + 20.0))


def hot_aisle_boxes(lay, cfg: dict) -> list[tuple[str, tuple, tuple, int, float]]:
    """열기 통로 격벽 상자 목록 [(이름, 아래 꼭짓점, 위 꼭짓점, 가로대 축, 가로대 간격)]. 장면 생성(build_scene, 상자/메시)이 함께 쓴다."""
    ct, cr = cfg["containment"], cfg["crac"]
    t, rz = ct["panel_thickness"], ct["roof_z"]
    W = lay.width
    xa, xb = cr["depth"], W - cr["depth"]
    n = len(lay.hot_aisles)
    out = []
    ceil = ceiling_mode(cfg)
    Z = ceiling_z(cfg)
    for k, (ya, yb) in enumerate(lay.hot_aisles, start=1):
        sides = [(o, (ya - t, ya) if o == -1 else (yb, yb + t)) for o in (-1, 1) if not ((k == 1 and o == -1) or (k == n and o == 1))]
        tagn = lambda o: "N" if o == 1 else "S"  # noqa: E731
        if not ceil:
            out.append((f"HotAisle_{k:02d}_Roof", (xa, ya, rz), (xb, yb, rz + t), 0, 120.0))
            for o, (lo_y, hi_y) in sides:
                for tag, (x0, x1) in (("W", (xa, lay.rack_x0)), ("E", (lay.rack_x1, xb))):
                    out.append((f"HotAisle_{k:02d}_Side{tagn(o)}_{tag}", (x0, lo_y, 0), (x1, hi_y, rz), 0, 0.0))
            continue
        # 천장 회수: 랙 위(rz) ~ 칸막이 천장(Z) 옆판, 줄 끝 문(바닥 ~ 천장, 위쪽은 고정 판). 지붕은 없고 천장 회수 그릴이 열려 있다
        for o, (lo_y, hi_y) in sides:
            out.append((f"HotAisle_{k:02d}_Side{tagn(o)}", (lay.rack_x0, lo_y, rz), (lay.rack_x1, hi_y, Z), 0, 0.0))
        for tag, (d0, d1) in (("W", (lay.rack_x0 - t, lay.rack_x0)), ("E", (lay.rack_x1, lay.rack_x1 + t))):
            out.append((f"HotAisle_{k:02d}_Door_{tag}", (d0, ya, 0), (d1, yb, Z), 1, 0.0))
    return out


def ceiling_boxes(lay, cfg: dict) -> list[tuple[str, tuple, tuple]]:
    """천장 회수 방식의 칸막이 천장 판과 공조기 연장 덕트 [(이름, 아래, 위)]. 열기 통로 위(줄 길이만큼)와 연장 덕트 자리는 비운다.
    냉기 통로 위 판은 Ceiling_Cold_k(공조기가 모자라 회수 공간이 넘칠 때 계산이 새는 길로 쓴다), 나머지는 Ceiling_n."""
    if not ceiling_mode(cfg):
        return []
    cr, t = cfg["crac"], cfg["containment"]["panel_thickness"]
    Z = ceiling_z(cfg)
    W, L = lay.width, lay.length
    cd, cw = cr["depth"], cr["width"]
    ys = crac_ys(lay, cfg)
    out = [(f"Collar_{s}{i + 1:02d}", ((0.0 if s == "W" else W - cd), y - cw / 2, cr["height"]), ((cd if s == "W" else W), y + cw / 2, Z + t))
           for s in ("W", "E") for i, y in enumerate(ys)]
    xb = sorted({0.0, cd, lay.rack_x0, lay.rack_x1, W - cd, W})
    yb = sorted({0.0, L} | {v for a in lay.hot_aisles + lay.cold_aisles for v in a} | {v for y in ys for v in (y - cw / 2, y + cw / 2)})
    rack = lambda x0, x1: x0 >= lay.rack_x0 - 1e-6 and x1 <= lay.rack_x1 + 1e-6  # noqa: E731
    inside = lambda y0, y1, rngs: any(y0 >= a - 1e-6 and y1 <= b + 1e-6 for a, b in rngs)  # noqa: E731
    collar = [(y - cw / 2, y + cw / 2) for y in ys]
    n = 0
    for x0, x1 in zip(xb[:-1], xb[1:]):
        edge = x1 <= cd + 1e-6 or x0 >= W - cd - 1e-6
        run = None  # 같은 이름으로 이어지는 y 구간을 하나로 합친다
        cells = []
        for y0, y1 in zip(yb[:-1], yb[1:]):
            if rack(x0, x1) and inside(y0, y1, lay.hot_aisles):
                name = None  # 회수 그릴(열림)
            elif edge and inside(y0, y1, collar):
                name = None  # 연장 덕트 자리
            elif rack(x0, x1) and inside(y0, y1, lay.cold_aisles):
                name = f"Ceiling_Cold_{[i for i, (a, b) in enumerate(lay.cold_aisles, 1) if y0 >= a - 1e-6 and y1 <= b + 1e-6][0]:02d}"
            else:
                name = "plain"
            if run and run[0] == name:
                run[2] = y1
            else:
                if run:
                    cells.append(run)
                run = [name, y0, y1]
        cells.append(run)
        for name, y0, y1 in cells:
            if name is None:
                continue
            if name == "plain":
                n += 1
                name = f"Ceiling_{n:02d}"
            out.append((name, (x0, y0, Z), (x1, y1, Z + t)))
    return out


def build_containment(stage, cont: str, lay, cfg: dict, mats: dict, col=None) -> dict:
    """열기 통로 격벽. 각 prim(dct:assetType=containment)은 Xform이고 자식으로 Frame(알루미늄 틀)과 Glass(반투명 패널)를 둔다.
    prim 전체의 경계 상자는 이전 Cube와 같다(틀이 바깥 가장자리를 채운다)."""
    ct, cr = cfg["containment"], cfg["crac"]
    t, rz = ct["panel_thickness"], ct["roof_z"]
    W = lay.width
    xa, xb = cr["depth"], W - cr["depth"]
    tri = {"Frame": 0, "Glass": 0}
    bar = 4.0

    def solid(path, lo, hi, mat, top=None):
        """유리 없는 상자 하나(칸막이 천장 판, 공조기 연장 덕트). top: 윗면만 다른 재질(연장 덕트 윗면의 흡입 그릴)."""
        x = UsdGeom.Xform.Define(stage, path)
        x.GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set("containment")
        mb = MeshB()
        if top:
            faces = {k: mat for k in ("+x", "-x", "+y", "-y", "-z")} | {"+z": top}
            mb.box(lo, hi, faces, planar(100.0), uvfs={"+z": planar(60.0)})
        else:
            mb.box(lo, hi, mat, planar(100.0))
        author_mesh(stage, f"{path}/Frame", mb, mats)
        tri["Frame"] += mb.triangles()

    def panel(path, lo, hi, cross_axis, cross_pitch):
        """틀 + 유리 판 하나. cross_axis: 가로대를 놓을 축(0=x, 1=y), cross_pitch: 가로대 간격."""
        x = UsdGeom.Xform.Define(stage, path)
        x.GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set("containment")
        sz = [hi[i] - lo[i] for i in range(3)]
        fr = MeshB()
        flat = [i for i in range(3) if i != 2]  # 틀이 놓이는 평면: 수평(지붕)이면 (x, y), 수직(옆면)이면 (x, z)
        if sz[2] <= t + 1e-6:  # 지붕: 수평 판. 두께 t는 z
            fr.box((lo[0], lo[1], lo[2]), (hi[0], lo[1] + bar, hi[2]), "frame")
            fr.box((lo[0], hi[1] - bar, lo[2]), (hi[0], hi[1], hi[2]), "frame")
            fr.box((lo[0], lo[1] + bar, lo[2]), (lo[0] + bar, hi[1] - bar, hi[2]), "frame")
            fr.box((hi[0] - bar, lo[1] + bar, lo[2]), (hi[0], hi[1] - bar, hi[2]), "frame")
            k = 1
            while cross_pitch > 0 and lo[0] + cross_pitch * k < hi[0] - bar - 20.0:  # 간격 0이면 가로대 없음(덕트 판)
                cx = lo[0] + cross_pitch * k
                fr.box((cx - bar / 2, lo[1] + bar, lo[2]), (cx + bar / 2, hi[1] - bar, hi[2]), "frame")
                k += 1
            glass_lo = (lo[0] + bar, lo[1] + bar, lo[2] + (hi[2] - lo[2]) / 2 - 0.5)
            glass_hi = (hi[0] - bar, hi[1] - bar, lo[2] + (hi[2] - lo[2]) / 2 + 0.5)
        elif sz[0] <= t + 1e-6:  # 끝 문: 수직 판. 두께 t는 x, 폭은 y, 높이 z (냉기 통로 격리의 통로 끝)
            fr.box((lo[0], lo[1], lo[2]), (hi[0], hi[1], lo[2] + 6.0), "frame")
            fr.box((lo[0], lo[1], hi[2] - 6.0), (hi[0], hi[1], hi[2]), "frame")
            fr.box((lo[0], lo[1], lo[2] + 6.0), (hi[0], lo[1] + bar, hi[2] - 6.0), "frame")
            fr.box((lo[0], hi[1] - bar, lo[2] + 6.0), (hi[0], hi[1], hi[2] - 6.0), "frame")
            ym = (lo[1] + hi[1]) / 2
            tall = hi[2] - lo[2] > DOOR_H + 30.0  # 천장까지 닿는 문: 아래는 미닫이 두 짝, 위는 고정 판
            zd = lo[2] + DOOR_H if tall else hi[2] - 6.0
            fr.box((lo[0], ym - bar / 2, lo[2] + 6.0), (hi[0], ym + bar / 2, zd), "frame")  # 미닫이 두 짝 사이
            if tall:
                fr.box((lo[0], lo[1] + bar, zd), (hi[0], hi[1] - bar, zd + 6.0), "frame")  # 문틀 윗막대(고정 판과의 경계)
                for yh in (ym - bar / 2 - 6.0, ym + bar / 2 + 4.0):  # 손잡이(문 두 짝이 만나는 곳 양옆, 높이 0.95 ~ 1.25 m)
                    fr.box((lo[0], yh, lo[2] + 95.0), (hi[0], yh + 2.0, lo[2] + 125.0), "frame")
            mid = (lo[0] + hi[0]) / 2
            glass_lo = (mid - 0.5, lo[1] + bar, lo[2] + 6.0)
            glass_hi = (mid + 0.5, hi[1] - bar, hi[2] - 6.0)
        else:  # 옆면: 수직 판. 두께 t는 y, 높이 z
            fr.box((lo[0], lo[1], lo[2]), (hi[0], hi[1], lo[2] + 6.0), "frame")
            fr.box((lo[0], lo[1], hi[2] - 6.0), (hi[0], hi[1], hi[2]), "frame")
            fr.box((lo[0], lo[1], lo[2] + 6.0), (lo[0] + bar, hi[1], hi[2] - 6.0), "frame")
            fr.box((hi[0] - bar, lo[1], lo[2] + 6.0), (hi[0], hi[1], hi[2] - 6.0), "frame")
            mid = (lo[1] + hi[1]) / 2
            glass_lo = (lo[0] + bar, mid - 0.5, lo[2] + 6.0)
            glass_hi = (hi[0] - bar, mid + 0.5, hi[2] - 6.0)
        gl = MeshB()
        gl.box(glass_lo, glass_hi, "glass", planar(100.0))
        author_mesh(stage, f"{path}/Frame", fr, mats)
        author_mesh(stage, f"{path}/Glass", gl, mats, double_sided=True)
        tri["Frame"] += fr.triangles()
        tri["Glass"] += gl.triangles()

    if containment_type(cfg) == "cold":
        # 냉기 통로 격리(CAC): 랙 앞면 사이(냉기 통로) 위를 지붕으로 덮고, 줄 끝 양쪽을 문으로 막는다. 열기 통로는 열려 있다
        for k, (ya, yb) in enumerate(lay.cold_aisles, start=1):
            panel(f"{cont}/ColdAisle_{k:02d}_Roof", (lay.rack_x0, ya, rz), (lay.rack_x1, yb, rz + t), 0, 120.0)
            panel(f"{cont}/ColdAisle_{k:02d}_Door_W", (lay.rack_x0 - t, ya, 0), (lay.rack_x0, yb, rz + t), 1, 0.0)
            panel(f"{cont}/ColdAisle_{k:02d}_Door_E", (lay.rack_x1, ya, 0), (lay.rack_x1 + t, yb, rz + t), 1, 0.0)
        return tri
    for name, lo, hi, axis, pitch in hot_aisle_boxes(lay, cfg):
        panel(f"{cont}/{name}", lo, hi, axis, pitch)
    for name, lo, hi in ceiling_boxes(lay, cfg):
        # 연장 덕트 윗면(칸막이 천장 위 회수 공간에서 빨아들이는 입구)은 흡입 그릴(T_EggCrate)
        solid(f"{cont}/{name}", lo, hi, "ceiling" if name.startswith("Ceiling") else "frame", top=None if name.startswith("Ceiling") else "grille")
    return tri


def rpp_boxes(lay, cfg: dict) -> list[tuple[str, tuple, tuple]]:
    """줄 끝 분전반(RPP, Remote Power Panel) [(이름, 아래, 위)]. 줄마다 서쪽 끝에 랙과 같은 깊이로 하나(docs/35).
    설정 power.rpp가 없으면 없다. 계산(hall60_sim, gen_case)은 막힌 상자로 읽는다(열은 내지 않는다고 본다)."""
    rp = cfg.get("power", {}).get("rpp")
    if not rp:
        return []
    d = cfg["rack"]["depth"]
    w, h = float(rp.get("width", 60)), float(rp.get("height", 200))
    return [(f"RPP_{i + 1:02d}", (lay.rack_x0 - w, y0, 0.0), (lay.rack_x0, y0 + d, h)) for i, y0 in enumerate(lay.row_y0)]


def build_power(stage, power: str, lay, cfg: dict, mats: dict) -> int:
    """분전반 캐비닛: 몸통, 앞판(줄 끝 통로 쪽, -x), 차단기 칸 줄, 표시창. prim은 dct:assetType = rpp(센서 없음)."""
    tri = 0
    for name, lo, hi in rpp_boxes(lay, cfg):
        p = f"{power}/{name}"
        UsdGeom.Xform.Define(stage, p).GetPrim().CreateAttribute("dct:assetType", Sdf.ValueTypeNames.Token, custom=True).Set("rpp")
        body = MeshB()
        body.box((lo[0] + 1.5, lo[1], lo[2]), hi, "rpp_body", planar(100.0))
        front = MeshB()
        x0 = lo[0]
        fy0, fy1, fz0, fz1 = lo[1] + 3.0, hi[1] - 3.0, 10.0, hi[2] - 4.0

        def face_uv(ax, positive, p, fy0=fy0, fy1=fy1, fz0=fz0, fz1=fz1):  # 앞판(-x 면)에 T_RppPanel 한 장. 앞에서 보아 오른쪽이 u+
            return ((fy1 - p[1]) / (fy1 - fy0), (p[2] - fz0) / (fz1 - fz0))

        front.box((x0, fy0, fz0), (x0 + 1.5, fy1, fz1), "rpp_front", planar(100.0), uvfs={"-x": face_uv})
        disp = MeshB()
        disp.box((x0 - 0.0, lo[1] + 30.0, hi[2] - 40.0), (x0 + 0.6, hi[1] - 30.0, hi[2] - 25.0), "rpp_display", planar(100.0))
        for nm, mb in (("Body", body), ("Front", front), ("Display", disp)):
            author_mesh(stage, f"{p}/{nm}", mb, mats)
            tri += mb.triangles()
    return tri


def build_vents(stage, vents: str, lay, cfg: dict, mats: dict) -> int:
    """바닥 급기구: 천공 타일 한 장(50 x 100 x 1 cm). 윗면이 텍스처 한 장(UV 0~1)이다."""
    vt, rk = cfg["vent"], cfg["rack"]
    n_per = cfg["rows"]["racks_per_row"]
    n = 0
    tris = 0
    for (ya, yb) in lay.cold_aisles:
        yc = (ya + yb) / 2
        for i in range(n_per):
            n += 1
            xc = lay.rack_x0 + rk["width"] * (i + 0.5)
            lo = (xc - vt["width"] / 2, yc - vt["depth"] / 2, 0.0)
            hi = (xc + vt["width"] / 2, yc + vt["depth"] / 2, float(vt["thickness"]))

            def uv(ax, positive, p, lo=lo, hi=hi):
                return ((p[0] - lo[0]) / (hi[0] - lo[0]), (p[1] - lo[1]) / (hi[1] - lo[1]))

            mb = MeshB()
            mb.box(lo, hi, "vent", uvfs={"+z": uv}, skip=("-z",))
            author_mesh(stage, f"{vents}/Vent_{n:02d}", mb, mats, "vent")
            tris += mb.triangles()
    return tris
