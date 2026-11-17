"""홀 내부 미리보기 이미지를 만든다(검수용). 장면 USD(hall01.usda)를 Blender로 읽어 EEVEE로 그린다. .blend는 저장하지 않는다.

실행 (저장소 루트에서):
    blender -b --factory-startup --python blender/scripts/render_hall_previews.py -- <장면 절대 경로> blender/previews [샘플수] [이름,이름...]

만드는 그림(hall_<이름>.png, 기본 2560 x 1440):
    section(홀 전체 절단도: 천장, 남쪽 벽, 조명을 숨기고 위에서 비스듬히), aisle(냉기 통로 눈높이), walkway(줄 끝 통로), rack_close(랙 앞문 근접),
    rack_servers(문을 숨기고 서버 앞면과 막음판), hot_aisle_door(열기 통로 끝 문), hot_aisle(열기 통로 안), ceiling_grille(천장 회수 그릴),
    vent_floor(급기구 바닥), rpp(줄 끝 분전반), crac(하향 송풍 공조기), crac_collar(연장 덕트와 칸막이 천장), hall_door(홀 출입문), rack_back(랙 뒷면)
- 카메라와 조명 위치는 형상 사본(experiments/openfoam_baseline/layout.json)과 장면의 조명 패널에서 정한다(docs/35)
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
sc.render.resolution_x, sc.render.resolution_y = 2560, 1440
sc.eevee.taa_render_samples = SAMPLES
sc.view_settings.view_transform = "Standard"

w = bpy.data.worlds.new("Hall")
w.use_nodes = True
bg = w.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (0.35, 0.36, 0.38, 1)
bg.inputs["Strength"].default_value = 0.8
sc.world = w

def under_light(o) -> bool:
    p = o.parent
    return p is not None and p.name.startswith("Light_")


# 배치는 형상 사본(layout.json, scripts/check_geometry.py가 장면과 같은지 본다)에서 읽는다. 예전에는 옛 홀(11 x 13.6 m)의 좌표를 숫자로 적어 두었다
import json  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LAY = json.load(open(os.path.join(ROOT, "experiments", "openfoam_baseline", "layout.json"), encoding="utf-8"))
W, L, H = LAY["size_cm"]
RX0 = min(r["min"][0] for r in LAY["racks"])
RX1 = max(r["max"][0] for r in LAY["racks"])
hot = sorted({(p["min"][1], p["max"][1]) for p in LAY["panels"] if "_Door_W" in p["name"] and p["name"].startswith("HotAisle_")})
cold_y = sorted({round((v["min"][1] + v["max"][1]) / 2) for v in LAY["vents"]})
ceil = [p for p in LAY["panels"] if p["name"].startswith("Ceiling_")]
CZ = min(p["min"][2] for p in ceil) if ceil else H
crac = sorted(LAY["cracs"], key=lambda c: c["name"])
rpp = sorted(LAY.get("obstacles", []), key=lambda o: o["name"])
lights = []


def area(name, loc_cm, size_cm, power):
    d = bpy.data.lights.new(name, "AREA")
    d.shape = "RECTANGLE"
    d.size, d.size_y = size_cm[0] * S, size_cm[1] * S
    d.energy = power
    d.use_shadow = False  # 면광원 수십 개의 그림자는 느리고 검수에 필요 없다
    o = bpy.data.objects.new(name, d)
    o.location = Vector(loc_cm) * S
    o.rotation_euler = (math.pi, 0, 0)  # 아래를 향한다
    sc.collection.objects.link(o)
    lights.append(o)


def world_box(o):
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return [min(p[i] for p in pts) / S for i in range(3)], [max(p[i] for p in pts) / S for i in range(3)]


# 조명: 장면의 조명 패널(Light_##/Diffuser) 자리마다 면광원 하나(USD에는 광원이 없다)
for o in bpy.data.objects:
    if o.type == "MESH" and under_light(o) and "Diffuser" in o.name:
        lo, hi = world_box(o)
        area(f"A_{o.parent.name}", ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] - 1.0), (hi[0] - lo[0], hi[1] - lo[1]), 80.0)
print("면광원", len(lights))

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


def hide(prefixes, on=True):
    objs = [o for o in bpy.data.objects if o.name.startswith(prefixes) or (o.parent and o.parent.name.startswith(prefixes))]
    for o in objs:
        o.hide_render = on
    return objs


# 1) 절단도: 천장(칸막이 천장과 회수 그릴 포함), 남쪽 벽과 문, 조명을 숨기고 위에서 비스듬히(햇빛 하나)
if not ONLY or "section" in ONLY:
    hidden = hide(("Ceiling", "Wall_South", "Light_", "Fire_Ceiling"))
    # 칸막이 천장 판(Containment/Ceiling_*): Blender가 메시 하나짜리 묶음을 합쳐 이름이 Frame.###가 되므로 높이(CZ에 놓인 얇은 판)로 찾는다
    for o in bpy.data.objects:
        if o.type == "MESH" and o.parent and o.parent.name == "Containment":
            lo, hi = world_box(o)
            if abs(lo[2] - CZ) < 1.0 and hi[2] - lo[2] < 10.0:
                o.hide_render = True
                hidden.append(o)
    for o in lights:
        o.hide_render = True
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(35), math.radians(10), math.radians(25))
    sc.collection.objects.link(sun)
    bg.inputs["Strength"].default_value = 1.2
    shot("section", (W / 2, -L * 0.25, L * 0.95), (W / 2, L * 0.45, 60), 22)
    bg.inputs["Strength"].default_value = 0.8
    bpy.data.objects.remove(sun)
    for o in hidden + lights:
        o.hide_render = False

c1 = cold_y[0]
h2 = (hot[1][0] + hot[1][1]) / 2
shot("aisle", (RX0 - 150, c1, 165), (RX1, c1, 140), 20)  # 냉기 통로 눈높이
shot("walkway", (RX0 - 120, 30, 170), (RX0 - 100, L - 150, 130), 18)  # 서쪽 줄 끝 통로: 공조기, 분전반, 열기 통로 문
shot("rack_close", (RX0 + 230, c1 + 2, 150), (RX0 + 170, c1 - 90, 105), 28)
if not ONLY or "rack_servers" in ONLY:  # 랙 문을 숨기고 서버 앞면과 빈칸 막음판을 본다
    doors = [o for o in bpy.data.objects if o.name.startswith("Door_") or (o.parent and o.parent.name == "Door")]
    for o in doors:
        o.hide_render = True
    shot("rack_servers", (RX0 + 215, c1 + 2, 110), (RX0 + 190, c1 - 90, 90), 26)
    for o in doors:
        o.hide_render = False
shot("hot_aisle_door", (RX0 - 200, h2 - 60, 160), (RX0, h2, 140), 24)  # 열기 통로 끝 문(미닫이 두 짝 + 고정 판)
shot("hot_aisle", (RX0 + 20, h2, 170), (RX1, h2, 150), 20)  # 열기 통로 안: 랙 뒷면, 스프링클러, 케이블 구멍 막음
shot("ceiling_grille", (RX0 + 200, h2 - 30, 110), (RX0 + 260, h2, CZ), 22)  # 열기 통로 위 회수 그릴 올려다보기
shot("vent_floor", (RX0, c1, 45), (RX0 + 230, c1, 0), 28)
if rpp:
    r = rpp[1]
    yc = (r["min"][1] + r["max"][1]) / 2
    shot("rpp", (r["min"][0] - 230, yc - 110, 150), (r["min"][0], yc, 110), 24)  # 줄 끝 분전반
c = crac[1]
cy = (c["min"][1] + c["max"][1]) / 2
shot("crac", (c["max"][0] + 150, cy - 170, 160), (c["max"][0], cy, 130), 20)  # 분전반(줄 끝)에 가리지 않게 줄 끝 통로 안에서  # 하향 송풍 공조기 앞면
shot("crac_collar", (c["max"][0] + 200, cy - 200, CZ - 30), (c["max"][0] - 20, cy, CZ - 60), 22)  # 연장 덕트와 칸막이 천장
shot("hall_door", (230, 420, 165), (230, 0, 120), 24)  # 남쪽 벽 장비 반입문
shot("rack_back", (RX0 + 150, hot[1][1] - 25, 140), (RX0 + 190, hot[1][0], 60), 26)  # 랙 뒷면과 바닥 브러시 막음
