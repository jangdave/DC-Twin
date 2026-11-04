"""랙과 CRAC의 .blend를 웹 보기 화면용 .glb로 내보낸다 (docs/18 11장, 작업 환경 확인: Blender 5.1).

텍스처는 넣지 않는다(4K 이미지는 용량이 크고 저장소에 원본이 없다). 대신 재질 이름마다 정한 색과 금속성, 거칠기를 쓴다.
모델 크기는 cm 숫자 그대로 나가므로(1 단위 = 1 m로 읽힘) 웹 쪽이 장면의 상자 크기에 맞춰 줄여 쓴다.

    blender -b blender/rack.blend --python blender/scripts/export_glb.py -- --out web/viewer/public/models
    blender -b blender/crac.blend --python blender/scripts/export_glb.py -- --out web/viewer/public/models
"""
import sys
from pathlib import Path

import bpy

# (2026-11-04: 서버실에 반사할 환경 이미지가 없어 금속성이 높으면 검게 보여, 금속성을 낮추고 색을 밝게 바꿈)
# 재질 이름 -> (기본 색 RGB 선형, 금속성, 거칠기, 발광 세기). 직접 정한 값이며 외부 자료를 쓰지 않았다.
LOOK = {
    "M_RackFrame": ((0.20, 0.22, 0.26), 0.35, 0.5, 0),
    "M_Door": ((0.17, 0.19, 0.22), 0.3, 0.5, 0),
    "M_DoorPerf": ((0.07, 0.075, 0.085), 0.2, 0.6, 0),
    "M_ServerHandle": ((0.55, 0.57, 0.60), 0.5, 0.4, 0),
    "M_CableBar": ((0.22, 0.23, 0.25), 0.3, 0.5, 0),
    "M_Caster": ((0.08, 0.08, 0.09), 0.8, 0.5, 0),
    "M_CasterWheel": ((0.015, 0.015, 0.015), 0.0, 0.8, 0),
    "M_ServerBody": ((0.11, 0.12, 0.14), 0.3, 0.5, 0),
    "M_ServerFront": ((0.15, 0.19, 0.25), 0.3, 0.45, 0),
    "M_CracBody": ((0.45, 0.50, 0.55), 0.3, 0.55, 0),
    "M_CracPlinth": ((0.05, 0.055, 0.06), 0.5, 0.6, 0),
    "M_CracCore": ((0.10, 0.11, 0.12), 0.4, 0.6, 0),
    "M_CracDisplay": ((0.005, 0.008, 0.01), 0.0, 0.3, 0),
    "M_CracGrille": ((0.04, 0.045, 0.05), 0.6, 0.5, 0),
    "M_CracHandle": ((0.30, 0.31, 0.33), 0.8, 0.35, 0),
    "M_CracLEDGreen": ((0.05, 0.9, 0.2), 0.0, 0.4, 2.0),
    "M_CracLEDAmber": ((1.0, 0.55, 0.05), 0.0, 0.4, 1.0),
    "M_CracReturn": ((0.015, 0.017, 0.02), 0.2, 0.7, 0),
    "M_CracSupply": ((0.08, 0.09, 0.10), 0.5, 0.55, 0),
    "M_CracTop": ((0.40, 0.45, 0.50), 0.3, 0.55, 0),
}
FALLBACK = ((0.2, 0.2, 0.22), 0.3, 0.6, 0)


def flatten_materials() -> list[str]:
    """이미지에 연결된 입력을 끊고 정한 색 값으로 바꾼다. 표에 없는 재질 이름은 목록으로 돌려준다."""
    unknown = []
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        color, metal, rough, emit = LOOK.get(m.name) or (unknown.append(m.name) or FALLBACK)
        for name in ("Base Color", "Metallic", "Roughness", "Normal", "Emission Color", "Emission Strength", "Alpha"):
            inp = bsdf.inputs.get(name)
            for link in list(inp.links) if inp else []:
                m.node_tree.links.remove(link)
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emit
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = 1.0
        m.blend_method = "OPAQUE" if hasattr(m, "blend_method") else None
    return unknown


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path("web/viewer/public/models")
    out.mkdir(parents=True, exist_ok=True)
    name = Path(bpy.data.filepath).stem  # rack, crac
    unknown = flatten_materials()
    if unknown:
        print("표에 없는 재질(기본값 사용):", unknown)
    path = out / f"{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_image_format="NONE",
        export_materials="EXPORT",
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )
    print(f"내보냄: {path} ({path.stat().st_size // 1024} KB)")


main()
