"""서버 랙 상세 모델을 만든다(블록아웃 `make_rack_blockout.py`의 후속). 부품마다 메시 하나, 종류별 그룹(Xform)으로 묶는다.

실행 (저장소 루트에서, 텍스처를 먼저 준비한다: docs/10_modeling_guide.md 12장):
    blender -b --factory-startup --python blender/scripts/make_rack_detailed.py -- blender/rack.blend

- 단위: 1 단위 = 1 cm. 바깥 크기 60 x 100 x 200 cm, 원점은 바닥 중앙, 앞쪽 -Y. 경계 상자는 블록아웃과 같다(시뮬레이션이 읽는다).
  문 손잡이처럼 튀어나온 것도 이 상자 안쪽(-50 ~ +50)에 둔다.
- 구조 (Rack 바로 아래):
    Frame/(Base, Top, Post_01~04, Panel_L/R, Rail_Front_L/R, Rail_Rear_L/R)  틀
    Door/(Front, Front_Handle, Rear_L, Rear_R, Rear_Handle)                  앞문, 뒷문(두 쪽)
    CableBar/(V_Left, V_Right, H_07, H_19, H_24, H_31)                      세로 케이블 정리 바, 앞면 가로 정리 바
    Blank/(U14_18, U25_29, U32_42)                                          빈 U 막음판(1U 판을 이어 붙임). 앞면 빈칸으로 뜨거운 공기가 되돌아오지 않게 막는다(docs/35)
    Caster/(FL, FR, RL, RR)                                                 아래 바퀴
    Server_U##  (assetType=server, 이름은 시작 U) / Server_U##_Face (앞면)     블록아웃과 같은 이름과 위치
    Anchors/Sensor_*                                                         센서 앵커(블록아웃과 같은 자리)
- 환기 구멍, 드라이브 칸, 표시등은 텍스처(T_ServerFront), 문의 구멍은 텍스처(T_RackDoor)다. 형상에 있는 것(문틀, 손잡이, 정리 바)은 텍스처에 다시 그리지 않는다.
- 실제 제품을 따라 만들지 않은 가상 장비다. 글자, 로고 없음.
"""
from __future__ import annotations

import sys

import bpy

sys.path.insert(0, __file__.rsplit("make_rack_detailed.py", 1)[0])
import hall_parts as hp  # noqa: E402
from hall_parts import MB2, Parts2  # noqa: E402

U = 4.445
RACK_W, RACK_D, RACK_H = 60.0, 100.0, 200.0
FIRST_U_Z = 9.0  # 첫 U의 바닥 높이(블록아웃과 같다)
TOTAL_U = 42
SERVERS = [(1, 1), (2, 1), (3, 2), (5, 2), (8, 1), (9, 1), (10, 4), (20, 2), (22, 2), (30, 1)]  # (시작 U, 높이 U): 블록아웃과 같다
BAR_US = (7, 19, 24, 31)  # 서버가 없는 U에 가로 케이블 정리 바
SERVER_W, FACE_W = 44.5, 48.26
SERVER_Y0, SERVER_D = -44.0, 70.0  # 몸통 앞면 y, 깊이
FACE_T = 1.0

TS_METAL = 100.0  # M_RackFrame 텍스처 실제 크기(cm). cc0_sources_hall.json의 tile_cm과 같다(눈으로 정한 값)
TS_DOOR = 60.0  # T_RackDoor 실제 크기(cm)
SF_U_PER_TILE = 8  # T_ServerFront 한 장 = 8U 높이, 가로 48.26 cm


def server_uv(ax, p):
    """서버 앞면 UV: 가로는 19인치 폭 한 장, 세로는 8U 한 장. 1U 칸이 텍스처의 한 칸에 맞는다."""
    return ((p[0] + FACE_W / 2) / FACE_W, (p[2] - FIRST_U_Z) / (SF_U_PER_TILE * U))


def make_materials():
    hp.use_hall_textures()
    return {
        "M_RackFrame": hp.tex_material("M_RackFrame", "T_HallBlackMetal", 0.8, True),
        "M_Door": hp.tex_material("M_Door", "T_HallBlackMetal", 0.8, True),
        "M_DoorPerf": hp.tex_material("M_DoorPerf", "T_RackDoor", 0.8, False),
        "M_ServerBody": hp.flat_material("M_ServerBody", (0.02, 0.02, 0.025), 0.3, 0.6),
        "M_ServerFront": hp.tex_material("M_ServerFront", "T_ServerFront", 0.3, False, emissive="T_ServerFront_Emissive", emis_strength=3.0),
        "M_ServerHandle": hp.flat_material("M_ServerHandle", (0.22, 0.23, 0.25), 0.6, 0.4),
        "M_CableBar": hp.flat_material("M_CableBar", (0.03, 0.03, 0.035), 0.1, 0.7),
        "M_Blank": hp.flat_material("M_Blank", (0.035, 0.037, 0.042), 0.3, 0.55),
        "M_Caster": hp.flat_material("M_Caster", (0.45, 0.46, 0.48), 0.9, 0.4),
        "M_CasterWheel": hp.flat_material("M_CasterWheel", (0.02, 0.02, 0.02), 0.0, 0.8),
    }


def frame(objs):
    F = Parts2("Frame", objs)
    post_h = 197.0 - 8.0
    F("Base").cbox((0, 0, 6.4), (RACK_W, RACK_D, 3.2), "M_RackFrame", ch=0.5, ts=TS_METAL)
    F("Top").cbox((0, 0, 198.5), (RACK_W, RACK_D, 3.0), "M_RackFrame", ch=0.5, ts=TS_METAL)
    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)], start=1):
        F(f"Post_{i:02d}").cbox((sx * 28.0, sy * 48.0, 8.0 + post_h / 2), (4.0, 4.0, post_h), "M_RackFrame", ch=0.6, ts=TS_METAL)
    # 옆판: 기둥 사이(y -46 ~ 46)에 바깥면이 기둥보다 0.6 cm 안쪽
    for tag, sx in (("L", -1), ("R", 1)):
        F(f"Panel_{tag}").cbox((sx * 28.8, 0, 102.5), (1.2, 92.0, post_h), "M_RackFrame", ts=TS_METAL)
    # 19인치 장착 레일: 서버 앞면 폭(48.26) 바깥, 기둥 안쪽
    for name, y in (("Front", -44.0), ("Rear", 28.0)):
        for tag, sx in (("L", -1), ("R", 1)):
            F(f"Rail_{name}_{tag}").cbox((sx * 25.2, y, 102.5), (1.6, 1.6, post_h), "M_RackFrame", ts=TS_METAL)


def door_ring(mb, x0, x1, y_out, y_in, z0, z1, bar=3.0):
    """문틀(막대 4개). x0~x1, z0~z1은 바깥 치수. y_out은 바깥면, y_in은 안쪽면."""
    yc, t = (y_out + y_in) / 2, abs(y_in - y_out)
    w, h = x1 - x0, z1 - z0
    xc, zc = (x0 + x1) / 2, (z0 + z1) / 2
    mb.cbox((xc, yc, z1 - bar / 2), (w, t, bar), "M_Door", ch=0.3, ts=TS_METAL)
    mb.cbox((xc, yc, z0 + bar / 2), (w, t, bar), "M_Door", ch=0.3, ts=TS_METAL)
    mb.cbox((x0 + bar / 2, yc, zc), (bar, t, h - 2 * bar), "M_Door", ch=0.3, ts=TS_METAL)
    mb.cbox((x1 - bar / 2, yc, zc), (bar, t, h - 2 * bar), "M_Door", ch=0.3, ts=TS_METAL)


def doors(objs):
    D = Parts2("Door", objs)
    z0, z1 = 9.0, 196.0
    bar = 3.0
    # 앞문 한 짝: 틀(y -48.5 ~ -47)과 천공 판(y -48 ~ -47)
    f = D("Front")
    door_ring(f, -26.0, 26.0, -48.5, -47.0, z0, z1, bar)
    f.cbox((0, -47.5, (z0 + z1) / 2), (52.0 - 2 * bar, 1.0, (z1 - z0) - 2 * bar), "M_DoorPerf", ts=TS_DOOR, uvo=(0.0, 0.0, 0.0))
    h = D("Front_Handle")  # 세로 손잡이와 받침 2개, 잠금 원통. 가장 앞쪽 y -49.7 (랙 앞면 -50 안쪽)
    h.cbox((20.0, -49.25, 100.0), (2.0, 0.9, 16.0), "M_ServerHandle", ch=0.4, ts=TS_METAL)
    h.cbox((20.0, -48.65, 94.0), (2.0, 0.3, 2.0), "M_ServerHandle", ts=TS_METAL, skip=("+y",))
    h.cbox((20.0, -48.65, 106.0), (2.0, 0.3, 2.0), "M_ServerHandle", ts=TS_METAL, skip=("+y",))
    h.cyl((20.0, -49.4, 118.0), 1.1, 0.9, "M_ServerHandle", seg=12, axis="y", ts=TS_METAL)
    # 뒷문: 두 쪽(가운데 0.3 cm 틈), 틀(y 47 ~ 48.5)과 천공 판(y 47 ~ 48)
    for tag, (xa, xb) in (("L", (-26.0, -0.15)), ("R", (0.15, 26.0))):
        r = D(f"Rear_{tag}")
        door_ring(r, xa, xb, 48.5, 47.0, z0, z1, bar)
        r.cbox(((xa + xb) / 2, 47.5, (z0 + z1) / 2), ((xb - xa) - 2 * bar, 1.0, (z1 - z0) - 2 * bar), "M_DoorPerf", ts=TS_DOOR, uvo=(xa, 0, 0))
    rh = D("Rear_Handle")
    for sx in (-1, 1):
        rh.cbox((sx * 3.0, 49.1, 100.0), (1.6, 1.2, 14.0), "M_ServerHandle", ch=0.4, ts=TS_METAL)


def cable_bars(objs):
    C = Parts2("CableBar", objs)
    # 세로 손가락형 정리 바(서버 뒤쪽 좌우): 뒤판 + 손가락 21쌍
    for tag, sx in (("Left", -1), ("Right", 1)):
        b = C(f"V_{tag}")
        b.cbox((sx * 25.0, 34.0, 100.0), (1.0, 8.0, 170.0), "M_CableBar", ts=TS_METAL)
        for k in range(21):
            z = 18.0 + k * 8.0
            for y in (30.4, 37.6):
                b.cbox((sx * 22.5, y, z), (4.0, 0.8, 3.0), "M_CableBar", ts=TS_METAL)
    # 앞면 가로 정리 바(1U): 위아래 레일 + 기둥 9개 -> 홈 8개
    for u in BAR_US:
        b = C(f"H_{u:02d}")
        h = U - 0.4
        zb = FIRST_U_Z + (u - 1) * U
        n = 8
        post_w = 1.6
        slot = (FACE_W - (n + 1) * post_w) / n
        b.cbox((0, -44.25, zb + 0.45), (FACE_W, 1.5, 0.9), "M_CableBar", ts=TS_METAL)
        b.cbox((0, -44.25, zb + h - 0.45), (FACE_W, 1.5, 0.9), "M_CableBar", ts=TS_METAL)
        for k in range(n + 1):
            x = -FACE_W / 2 + post_w / 2 + k * (post_w + slot)
            b.cbox((x, -44.25, zb + h / 2), (post_w, 1.5, h - 1.8), "M_CableBar", ts=TS_METAL)


def empty_ranges() -> list[tuple[int, int]]:
    """서버도 가로 정리 바도 없는 U 구간 [(시작, 끝)]."""
    used = {u for s, h in SERVERS for u in range(s, s + h)} | set(BAR_US)
    out, start = [], None
    for u in range(1, TOTAL_U + 1):
        if u not in used and start is None:
            start = u
        if (u in used or u == TOTAL_U) and start is not None:
            end = u if u not in used else u - 1
            out.append((start, end))
            start = None
    return out


def blanks(objs):
    B = Parts2("Blank", objs)
    for a, b in empty_ranges():
        mb = B(f"U{a:02d}_{b:02d}")
        for u in range(a, b + 1):  # 1U 판마다 0.4 cm 틈(판이 여러 장인 것이 보이게)
            zb = FIRST_U_Z + (u - 1) * U
            mb.cbox((0, SERVER_Y0 - FACE_T / 2, zb + (U - 0.4) / 2), (FACE_W, FACE_T, U - 0.4), "M_Blank", ch=0.15, ts=TS_METAL)


def casters(objs):
    G = Parts2("Caster", objs)
    for name, (sx, sy) in (("FL", (-1, -1)), ("FR", (1, -1)), ("RL", (-1, 1)), ("RR", (1, 1))):
        x, y = sx * 24.0, sy * 44.0
        c = G(name)
        c.cbox((x, y, 4.3), (5.0, 5.0, 1.0), "M_Caster", ts=TS_METAL)  # 받침판 z 3.8 ~ 4.8
        for dx in (-1.3, 1.3):  # 포크
            c.cbox((x + dx, y, 3.0), (0.4, 2.4, 1.6), "M_Caster", ts=TS_METAL)
        w = G(f"{name}_Wheel")
        w.cyl((x - 0.8, y, 1.9), 1.9, 1.6, "M_CasterWheel", seg=12, axis="x", ts=TS_METAL)


def servers(objs_unused, mats, rack):
    made = []
    for start_u, height_u in SERVERS:
        h = height_u * U - 0.4
        zb = FIRST_U_Z + (start_u - 1) * U
        zc = zb + h / 2
        body = MB2(f"Server_U{start_u:02d}")
        body.cbox((0, SERVER_Y0 + SERVER_D / 2, zc), (SERVER_W, SERVER_D, h), "M_ServerBody", ts=TS_METAL)
        ob = body.build(mats, rack)
        ob["assetType"] = "server"
        face = MB2(f"Server_U{start_u:02d}_Face")
        face.cbox((0, SERVER_Y0 - FACE_T / 2, zc), (FACE_W, FACE_T, h), "M_ServerFront", ch=0.2, ts=TS_METAL, uvf=server_uv)
        for sx in (-1, 1):  # 귀 손잡이(앞으로 0.8 cm 튀어나옴)
            face.cbox((sx * 23.0, SERVER_Y0 - FACE_T - 0.4, zc), (1.4, 0.8, max(1.4, h * 0.5)), "M_ServerHandle", ch=0.2, ts=TS_METAL)
        made.append(body)
        made.append(face)
        face.build(mats, ob)
    return made


def build() -> None:
    hp.setup_units()
    mats = make_materials()
    rack = hp.empty("Rack", (0, 0, 0))
    rack["assetType"] = "rack"
    objs: list = []
    frame(objs)
    doors(objs)
    cable_bars(objs)
    blanks(objs)
    casters(objs)
    hp.place(objs, mats, rack)
    sv = servers(objs, mats, rack)
    hp.add_anchors(rack, (
        ("temp_in", "degC", -RACK_D / 2 - 5.0, RACK_H * 0.6),
        ("temp_out", "degC", RACK_D / 2 + 5.0, RACK_H * 0.6),
        ("power", "kW", 0.0, RACK_H * 0.9),
    ))
    for b in objs:
        print(f"  {b.name:24s} 삼각형 {b.triangles():6d}")
    total = hp.report(objs + sv, "랙")
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    lo, hi = [1e9] * 3, [-1e9] * 3
    for ob in bpy.data.objects:
        if ob.type == "MESH":
            e = ob.evaluated_get(dg)
            me = e.to_mesh()
            me.calc_loop_triangles()
            n += len(me.loop_triangles)
            for v in me.vertices:
                w = ob.matrix_world @ v.co
                for i in range(3):
                    lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
            e.to_mesh_clear()
    print("Blender가 센 삼각형 수:", n)
    print("경계 상자 최소", [round(v, 3) for v in lo], "최대", [round(v, 3) for v in hi])


if __name__ == "__main__":
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "rack.blend"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build()
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print("저장:", out)
