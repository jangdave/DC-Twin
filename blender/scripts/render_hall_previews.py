"""홀 내부 미리보기 이미지를 만든다(검수용). 장면 USD(hall01.usda)를 Blender로 읽어 EEVEE로 그린다. .blend는 저장하지 않는다.

실행 (저장소 루트에서):
    blender -b --factory-startup --python blender/scripts/render_hall_previews.py -- <장면 절대 경로> blender/previews [샘플수] [이름,이름...]

만드는 그림(hall_<이름>.png, 1600 x 900):
    section(홀 전체 절단도: 천장, 남쪽 벽, 조명을 숨기고 위에서 비스듬히), aisle(통로 눈높이), rack_close(랙 앞문 근접), rack_servers(문을 숨기고 서버 앞면),
    hot_aisle(열기 통로 격벽 안쪽), vent_floor(급기구 바닥), crac(CRAC 회수면), crac_top(CRAC 상단 덮개와 팬), rack_back(랙 뒷면)
- Blender는 USD를 미터 단위로 읽는다. 이 스크립트의 좌표는 cm로 쓰고 S=0.01을 곱한다.
- 조명은 Blender 안에서만 놓는다(USD에는 광원이 없다). 조명 패널 위치에 면광원을 둔다.
- 장면 경로는 절대 경로여야 한다(Blender가 상대 경로를 드라이브 루트에서 찾는다).
"""
from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
SCENE = os.path.abspath(args[0])
OUT = os.path.abspath(args[1])
SAMPLES = int(args[2]) if len(args) > 2 else 32
ONLY = set(args[3].split(",")) if len(args) > 3 else None
os.makedirs(OUT, exist_ok=True)
S = 0.01

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=SCENE, import_cameras=False, import_lights=False, import_materials=True, import_usd_preview=True)

sc = bpy.context.scene
for m in bpy.data.materials:
    if not m.node_tree:
        continue
    b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if b is None:
        continue
    if m.name.startswith("M_ContainGlass"):
        m.use_backface_culling = False
    if m.name.startswith("M_LightPanel"):
        b.inputs["Emission Strength"].default_value = 1.2
    if m.name.startswith("M_ServerFront"):
        b.inputs["Emission Strength"].default_value = 3.0

sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
sc.eevee.taa_render_samples = SAMPLES
sc.view_settings.view_transform = "Standard"

w = bpy.data.worlds.new("Hall")
w.use_nodes = True
bg = w.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (0.35, 0.36, 0.38, 1)
bg.inputs["Strength"].default_value = 0.8
sc.world = w

H = 400.0
cold_y = [260.0, 680.0, 1100.0]
hot_y = [50.0, 470.0, 890.0, 1310.0]
lights = []


def area(name, loc_cm, size_cm, power):
    d = bpy.data.lights.new(name, "AREA")
    d.shape = "RECTANGLE"
    d.size, d.size_y = size_cm[0] * S, size_cm[1] * S
    d.energy = power
    d.use_shadow = False  # 면광원 42개의 그림자는 느리고 검수에 필요 없다
    o = bpy.data.objects.new(name, d)
    o.location = Vector(loc_cm) * S
    o.rotation_euler = (math.pi, 0, 0)  # 아래를 향한다
    sc.collection.objects.link(o)
    lights.append(o)


for y in cold_y:
    for k in range(6):
        area(f"CL_{y}_{k}", (175 + 150 * k, y, H - 4), (120, 20), 90.0)
for y in hot_y:
    for k in range(6):
        area(f"HL_{y}_{k}", (175 + 150 * k, y, 195), (100, 15), 60.0)

cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.clip_start = 0.03
cam.data.clip_end = 80.0


def shot(name, loc_cm, target_cm, lens=24.0):
    if ONLY and name not in ONLY:
        return
    cam.location = Vector(loc_cm) * S
    cam.data.lens = lens
    d = Vector(target_cm) * S - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = f"{OUT}/hall_{name}.png"
    bpy.ops.render.render(write_still=True)
    print("렌더:", sc.render.filepath)


def under_light(o) -> bool:
    p = o.parent
    return p is not None and p.name.startswith("Light_")


# 1) 절단도: 천장, 남쪽 벽, 조명 패널을 숨기고 위에서 비스듬히 내려다본다(햇빛 하나)
if not ONLY or "section" in ONLY:
    hidden = [o for o in bpy.data.objects if o.name.startswith(("Ceiling", "Wall_South", "Light_")) or under_light(o)]
    for o in hidden:
        o.hide_render = True
    for o in lights:
        o.hide_render = True
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(35), math.radians(10), math.radians(25))
    sc.collection.objects.link(sun)
    bg.inputs["Strength"].default_value = 1.2
    shot("section", (550, -300, 1500), (550, 700, 60), 22)
    bg.inputs["Strength"].default_value = 0.8
    bpy.data.objects.remove(sun)
    for o in hidden + lights:
        o.hide_render = False

shot("aisle", (150, 260, 165), (900, 260, 140), 20)
shot("rack_close", (560, 262, 150), (500, 200, 105), 28)
# 랙 문을 숨기고 서버 앞면을 본다
doors = [o for o in bpy.data.objects if o.name.startswith("Door_")]
if not ONLY or "rack_servers" in ONLY:
    for o in doors:
        o.hide_render = True
    shot("rack_servers", (545, 262, 110), (520, 200, 80), 30)
    for o in doors:
        o.hide_render = False
shot("hot_aisle", (330, 470, 170), (950, 470, 110), 22)
shot("vent_floor", (330, 262, 45), (560, 262, 0), 28)
shot("crac", (330, 500, 150), (60, 470, 120), 24)
shot("crac_top", (230, 330, 335), (50, 470, 190), 30)
shot("rack_back", (480, 480, 140), (520, 420, 100), 28)
