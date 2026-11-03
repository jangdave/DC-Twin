"""건물 외관(building_exterior.blend)을 웹 보기용 .glb로 내보낸다 (docs/22).

텍스처는 기본색(BaseColor) 한 장만 1K(1024)로 줄여 넣는다(4K 원본 4종은 약 230 MB). 거칠기, 법선, 금속 지도는 버리고
재질 이름마다 정한 값을 쓴다. 나머지 재질은 정한 색, 금속성, 거칠기, 투명도만 쓴다. 메시는 Draco로 압축한다.
모델 크기는 cm 숫자 그대로 나가므로 뷰어가 0.01배로 줄여 쓴다.

    blender -b blender/building_exterior.blend --python blender/scripts/export_building_glb.py -- --out web/viewer/public/models
"""
import sys
from pathlib import Path

import bpy

# 재질 이름 -> (기본색 RGB 선형, 금속성, 거칠기, 불투명도). 직접 정한 값이며 외부 자료를 쓰지 않았다.
LOOK = {
    "M_BldgConcrete": ((0.30, 0.30, 0.29), 0.0, 0.9, 1.0),
    "M_BldgWallCore": ((0.22, 0.23, 0.24), 0.1, 0.8, 1.0),
    "M_BldgPanelMetal": ((0.42, 0.44, 0.46), 0.6, 0.45, 1.0),
    "M_BldgRoof": ((0.12, 0.12, 0.13), 0.0, 0.9, 1.0),
    "M_BldgLouver": ((0.06, 0.065, 0.07), 0.5, 0.5, 1.0),
    "M_BldgFan": ((0.55, 0.57, 0.60), 0.7, 0.4, 1.0),
    "M_BldgGlass": ((0.10, 0.18, 0.24), 0.0, 0.1, 0.35),
    "M_BldgCurtainGlass": ((0.10, 0.18, 0.24), 0.0, 0.1, 0.35),
    "M_BldgMullion": ((0.08, 0.08, 0.09), 0.7, 0.4, 1.0),
    "M_BldgFloorProxy": ((0.2, 0.2, 0.2), 0.0, 0.9, 1.0),
    "M_OutdoorEquip": ((0.35, 0.38, 0.36), 0.4, 0.55, 1.0),
    "M_Fence": ((0.10, 0.11, 0.12), 0.6, 0.5, 1.0),
    "M_ParkingPaint": ((0.75, 0.72, 0.55), 0.0, 0.7, 1.0),
    "M_Foliage": ((0.05, 0.16, 0.05), 0.0, 0.85, 1.0),
    "M_Trunk": ((0.10, 0.06, 0.035), 0.0, 0.9, 1.0),
    "M_Asphalt": ((0.045, 0.047, 0.05), 0.0, 0.95, 1.0),
}
FALLBACK = ((0.3, 0.3, 0.3), 0.2, 0.7, 1.0)


TEX_SIZE = 1024
KEEP_BASECOLOR = {"M_Asphalt", "M_BldgConcrete", "M_BldgPanelMetal", "M_BldgRoof"}


def flatten_materials() -> list[str]:
    unknown = []
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        if m.name not in LOOK:
            unknown.append(m.name)
        color, metal, rough, alpha = LOOK.get(m.name, FALLBACK)
        keep = m.name in KEEP_BASECOLOR
        for name in ("Base Color", "Metallic", "Roughness", "Normal", "Emission Color", "Emission Strength", "Alpha"):
            if keep and name == "Base Color":
                for link in bsdf.inputs[name].links:
                    img = link.from_node.image if link.from_node.type == "TEX_IMAGE" else None
                    if img and max(img.size) > TEX_SIZE:
                        img.scale(TEX_SIZE, TEX_SIZE)
                continue
            inp = bsdf.inputs.get(name)
            for link in list(inp.links) if inp else []:
                m.node_tree.links.remove(link)
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Alpha"].default_value = alpha
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 0.0
    return unknown


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path("web/viewer/public/models")
    out.mkdir(parents=True, exist_ok=True)
    unknown = flatten_materials()
    if unknown:
        print("표에 없는 재질(기본값 사용):", unknown)
    path = out / "building.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_image_format="JPEG",
        export_jpeg_quality=80,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_materials="EXPORT",
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )
    print(f"내보냄: {path} ({path.stat().st_size // 1024} KB)")


main()
