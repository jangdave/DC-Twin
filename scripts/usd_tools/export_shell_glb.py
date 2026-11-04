"""서버실 껍데기(Shell)를 웹 보기 화면용 .glb로 내보낸다 (docs/27 12장 2단계).

- 입력은 장면 USD(`usd/scenes/hall01.usda`)의 `/DC/Hall01/Shell`이다. 손으로 만든 모델이 아니라 장면에서 읽는다.
- 좌표는 웹 장면 좌표로 바꿔 둔다: (x, y, z) cm -> (x, z, -y) m. 그래서 웹에서 따로 옮기거나 줄이지 않는다.
- 재질 묶음마다 메시 하나로 합친다(그리기 호출 수를 줄이기 위해). 이름은 재질 묶음 이름이다.
- 텍스처는 넣지 않는다(저장소에 원본이 없고 용량이 크다). 바닥과 천장의 타일 무늬는 웹이 만든다. UV(0~1이 아니라 USD의 st 값)는 남긴다.

사용 (scripts/usd_tools에서):  uv run --python 3.13 python export_shell_glb.py ../../usd/scenes/hall01.usda ../../web/viewer/public/models/hall_shell.glb
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
from pxr import Usd, UsdGeom, UsdShade

SHELL = "/DC/Hall01/Shell"
CM = 0.01


def group_of(prim, mat_name: str | None) -> str:
    """메시를 어느 묶음에 넣을지 정한다. 바닥은 재질이 없어서 이름으로 가른다."""
    n = prim.GetName()
    if n == "Floor":
        return "floor"
    if n.startswith("Wall_"):
        return n.lower()  # wall_west 등. 웹이 카메라 쪽 벽만 숨기려고 따로 둔다
    return {
        "M_HallWall": "wall", "M_HallCeiling": "ceiling", "M_HallSkirting": "skirting", "M_HallLine": "line",
        "M_HallHazard": "hazard", "M_LightFrame": "lightframe", "M_LightPanel": "lightpanel",
    }.get(mat_name or "", "other")


def collect(stage) -> dict[str, dict]:
    cache = UsdGeom.XformCache()
    groups: dict[str, dict] = {}
    for p in Usd.PrimRange(stage.GetPrimAtPath(SHELL)):
        if not p.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(p)
        mat = UsdShade.MaterialBindingAPI(p).ComputeBoundMaterial()[0]
        g = groups.setdefault(group_of(p, mat.GetPath().name if mat else None), {"pos": [], "nrm": [], "uv": [], "idx": []})
        m = np.array(cache.GetLocalToWorldTransform(p)).T  # pxr는 행 벡터 규약이라 전치
        pts = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
        counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
        ids = np.array(mesh.GetFaceVertexIndicesAttr().Get())
        st = p.GetAttribute("primvars:st")
        uvs = np.array(st.Get(), dtype=np.float64) if st.IsValid() and st.Get() is not None else None
        uv_idx = p.GetAttribute("primvars:st:indices")
        uv_ids = np.array(uv_idx.Get()) if uv_idx.IsValid() and uv_idx.Get() is not None else None
        world = (m[:3, :3] @ pts.T).T + m[:3, 3]
        # 면마다 점을 따로 쓴다(면 법선과 UV가 면 단위라서). 삼각형 부채로 쪼갠다.
        k = 0
        base = sum(len(a) for a in g["pos"])
        out_p, out_n, out_u, out_i = [], [], [], []
        for c in counts:
            fi = ids[k:k + c]
            fp = world[fi]
            nrm = np.cross(fp[1] - fp[0], fp[2] - fp[0])
            ln = np.linalg.norm(nrm)
            nrm = nrm / ln if ln > 0 else np.array([0, 0, 1.0])
            if uvs is None:
                fu = np.zeros((c, 2))
            elif uv_ids is not None and len(uv_ids) == len(ids):
                fu = uvs[uv_ids[k:k + c]]
            elif len(uvs) == len(ids):
                fu = uvs[k:k + c]
            else:
                fu = uvs[fi]
            n0 = base + sum(len(a) for a in out_p)
            out_p.append(fp)
            out_n.append(np.tile(nrm, (c, 1)))
            out_u.append(fu)
            for j in range(1, c - 1):
                out_i.append([n0, n0 + j, n0 + j + 1])
            k += c
        g["pos"] += out_p
        g["nrm"] += out_n
        g["uv"] += out_u
        g["idx"] += out_i
    return groups


def to_web(a: np.ndarray) -> np.ndarray:
    """USD(cm, Z 위) -> 웹(m, Y 위, 앞쪽 -Z)."""
    return np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1) * CM


def to_web_dir(a: np.ndarray) -> np.ndarray:
    return np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)


# 재질 묶음 -> (기본 색 선형 RGB, 금속성, 거칠기, 발광 RGB). 직접 정한 값이다.
LOOK = {
    "floor": ((0.30, 0.31, 0.33), 0.0, 0.55, (0, 0, 0)),
    **{f"wall_{d}": ((0.62, 0.63, 0.64), 0.0, 0.85, (0, 0, 0)) for d in ("west", "east", "south", "north")},
    "ceiling": ((0.70, 0.71, 0.72), 0.0, 0.9, (0, 0, 0)),
    "skirting": ((0.08, 0.08, 0.09), 0.2, 0.6, (0, 0, 0)),
    "line": ((0.85, 0.65, 0.05), 0.0, 0.7, (0, 0, 0)),
    "hazard": ((0.80, 0.60, 0.05), 0.0, 0.7, (0, 0, 0)),
    "lightframe": ((0.15, 0.16, 0.17), 0.5, 0.5, (0, 0, 0)),
    "lightpanel": ((0.9, 0.95, 1.0), 0.0, 0.4, (1.0, 1.0, 1.0)),
    "other": ((0.4, 0.4, 0.4), 0.0, 0.7, (0, 0, 0)),
}


def write_glb(groups: dict[str, dict], path: Path) -> dict:
    bin_chunks: list[bytes] = []
    views, accessors, meshes, nodes, materials = [], [], [], [], []
    stats = {}

    def add(data: bytes, target: int | None) -> int:
        off = sum(len(c) for c in bin_chunks)
        bin_chunks.append(data + b"\x00" * (-len(data) % 4))
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    for name, g in groups.items():
        if not g["idx"]:
            continue
        pos = to_web(np.concatenate(g["pos"])).astype(np.float32)
        nrm = to_web_dir(np.concatenate(g["nrm"])).astype(np.float32)
        uv = np.concatenate(g["uv"]).astype(np.float32)
        uv[:, 1] = 1.0 - uv[:, 1]  # glTF는 UV 원점이 왼쪽 위
        idx = np.array(g["idx"], dtype=np.uint32).reshape(-1)
        # 좌표 변환(Z 위 -> Y 위)은 거울이 아니라 회전이라 면 방향이 그대로다. 단, -y 때문에 확인용으로 법선과 점 순서를 맞춘다.
        a_pos = add(pos.tobytes(), 34962)
        a_nrm = add(nrm.tobytes(), 34962)
        a_uv = add(uv.tobytes(), 34962)
        a_idx = add(idx.tobytes(), 34963)
        base = len(accessors)
        accessors += [
            {"bufferView": a_pos, "componentType": 5126, "count": len(pos), "type": "VEC3", "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
            {"bufferView": a_nrm, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
            {"bufferView": a_uv, "componentType": 5126, "count": len(uv), "type": "VEC2"},
            {"bufferView": a_idx, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ]
        color, metal, rough, emit = LOOK[name]
        mat = {"name": f"S_{name}", "pbrMetallicRoughness": {"baseColorFactor": [*color, 1], "metallicFactor": metal, "roughnessFactor": rough}}
        if any(emit):
            mat["emissiveFactor"] = list(emit)
        materials.append(mat)
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": base, "NORMAL": base + 1, "TEXCOORD_0": base + 2}, "indices": base + 3, "material": len(materials) - 1}]})
        nodes.append({"name": name, "mesh": len(meshes) - 1})
        stats[name] = len(idx) // 3
    binary = b"".join(bin_chunks)
    doc = {
        "asset": {"version": "2.0", "generator": "dct export_shell_glb.py"},
        "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes,
        "materials": materials, "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(binary)}],
        "extensionsUsed": [], 
    }
    doc.pop("extensionsUsed")
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)
    return stats


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    stage = Usd.Stage.Open(str(src))
    stats = write_glb(collect(stage), dst)
    print("삼각형:", stats, "합계", sum(stats.values()), f"크기 {dst.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
