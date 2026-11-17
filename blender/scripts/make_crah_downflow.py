"""하향 송풍 공조기(CRAH) 상세 모델. 이중 바닥으로 찬 공기를 내려보내고 윗면으로 뜨거운 공기를 빨아들인다(docs/35).

실행 (저장소 루트에서, 텍스처를 먼저 준비한다):
    blender -b --factory-startup --python blender/scripts/make_crah_downflow.py -- blender/crah.blend

- 단위: 1 단위 = 1 cm. 바깥 크기 240 x 90 x 220 cm(폭 x 깊이 x 높이). 원점은 바닥 중앙, 앞쪽(-Y)이 점검하는 면(문과 표시창).
  100 kW급 하향 송풍 공조기의 흔한 크기(폭 약 2.5~3 m, 깊이 약 0.9 m)를 따랐다. 옛 모델(`make_crac_detailed.py`, 90 x 100 x 220,
  앞면 흡입)은 같은 유량(9.6 m3/s)을 받기에 흡입 면적이 너무 작았다.
- 구조 (CRAH 바로 아래):
    Base/(Plinth, Core)                          받침(바닥 10 cm)과 속(어두운 몸통)
    Side/(Panel_L, Panel_R)                      옆 패널
    Front/(Door_01~03, Handle_01~03, Status)     앞 문 3짝, 손잡이, 상태 표시창과 표시등
    Rear/(Panel_01~03)                           뒷면 패널
    Top/(Frame, Grille, Back)                    윗면 흡입구: 틀, 살, 뒤쪽 어두운 판(천장 회수 공간으로 잇는 덕트가 여기에 붙는다)
    Anchors/Sensor_*                             센서 앵커
- 실제 제품을 따라 만들지 않은 가상 장비다. 글자, 로고 없음.
"""
from __future__ import annotations

import sys

import bpy

sys.path.insert(0, __file__.rsplit("make_crah_downflow.py", 1)[0])
import hall_parts as hp  # noqa: E402
from hall_parts import Parts2  # noqa: E402

W, D, H = 240.0, 90.0, 220.0
TS = 100.0  # T_CracPaint 실제 크기(cm)
GAP = 0.4
PT = 1.6  # 패널 두께


def make_materials():
    hp.use_hall_textures()
    return {
        "M_CracBody": hp.tex_material("M_CracBody", "T_CracPaint", 0.4, False),
        "M_CracPlinth": hp.flat_material("M_CracPlinth", (0.10, 0.105, 0.11), 0.4, 0.6),
        "M_CracCore": hp.flat_material("M_CracCore", (0.015, 0.015, 0.018), 0.2, 0.8),
        "M_CracReturn": hp.flat_material("M_CracReturn", (0.05, 0.05, 0.06), 0.2, 0.7),  # 흡입구 뒤판
        "M_CracGrille": hp.flat_material("M_CracGrille", (0.07, 0.075, 0.08), 0.7, 0.4),
        "M_CracTop": hp.flat_material("M_CracTop", (0.30, 0.32, 0.35), 0.5, 0.5),
        "M_CracHandle": hp.flat_material("M_CracHandle", (0.20, 0.21, 0.23), 0.8, 0.35),
        "M_CracDisplay": hp.emissive_material("M_CracDisplay", (0.10, 0.80, 0.70), 2.0),
        "M_CracLEDGreen": hp.emissive_material("M_CracLEDGreen", (0.1, 1.0, 0.25), 4.0),
        "M_CracLEDAmber": hp.emissive_material("M_CracLEDAmber", (1.0, 0.6, 0.1), 4.0),
    }


def build_parts(objs):
    X = W / 2 - 1.2  # 앞뒤 패널 가로 반폭
    YF, YR = -D / 2 + 0.8, D / 2 - 0.8  # 앞 패널 바깥면, 뒤 패널 바깥면(받침이 -45 ~ 45를 차지)
    z_lo, z_hi = 11.0, 212.0

    B = Parts2("Base", objs)
    B("Plinth").cbox((0, 0, 5.0), (W, D, 10.0), "M_CracPlinth", ch=0.5, ts=TS)
    B("Core").cbox((0, 0, 111.0), (W - 4.0, D - 4.0, 202.0), "M_CracCore", ts=TS)

    S = Parts2("Side", objs)
    for tag, sx in (("L", -1), ("R", 1)):
        S(f"Panel_{tag}").cbox((sx * (W / 2 - 0.6), 0, (z_lo + z_hi) / 2), (1.2, D - 1.6, z_hi - z_lo), "M_CracBody", ch=0.3, ts=TS)

    # 앞 문 3짝(점검용). 흡입구가 윗면이라 앞면은 막혀 있다
    F = Parts2("Front", objs)
    n = 3
    dw = (2 * X - (n - 1) * GAP) / n
    for k in range(n):
        x0 = -X + k * (dw + GAP)
        xc = x0 + dw / 2
        F(f"Door_{k + 1:02d}").cbox((xc, YF + PT / 2, (z_lo + z_hi) / 2), (dw, PT, z_hi - z_lo), "M_CracBody", ch=0.3, ts=TS)
        F(f"Handle_{k + 1:02d}").cbox((x0 + dw - 8.0, YF - 0.35, 110.0), (2.0, 0.7, 14.0), "M_CracHandle", ch=0.2, ts=TS)
    st = F("Status")  # 가운데 문 위쪽의 상태 표시창과 표시등 3개
    st.cbox((0, YF - 0.2, 190.0), (24.0, 1.0, 8.0), "M_CracDisplay", ts=TS)
    for dx, m in ((-22.0, "M_CracLEDGreen"), (-18.0, "M_CracLEDAmber"), (-14.0, "M_CracLEDGreen")):
        st.cbox((dx, YF - 0.2, 178.0), (1.6, 1.0, 1.6), m, ts=TS)

    Rr = Parts2("Rear", objs)
    for k in range(n):
        x0 = -X + k * (dw + GAP)
        Rr(f"Panel_{k + 1:02d}").cbox((x0 + dw / 2, YR - PT / 2, (z_lo + z_hi) / 2), (dw, PT, z_hi - z_lo), "M_CracBody", ch=0.3, ts=TS)

    # 윗면 흡입구: 틀(폭 6 cm) + 살(깊이 방향으로 길게, 폭 방향으로 늘어놓음) + 뒤판
    T = Parts2("Top", objs)
    zt0, zt1 = z_hi, H - 0.2
    fr = T("Frame")
    bar = 6.0
    zc, th = (zt0 + zt1) / 2, zt1 - zt0
    fr.cbox((0, -D / 2 + bar / 2, zc), (W, bar, th), "M_CracTop", ch=0.3, ts=TS)
    fr.cbox((0, D / 2 - bar / 2, zc), (W, bar, th), "M_CracTop", ch=0.3, ts=TS)
    fr.cbox((-W / 2 + bar / 2, 0, zc), (bar, D - 2 * bar, th), "M_CracTop", ch=0.3, ts=TS)
    fr.cbox((W / 2 - bar / 2, 0, zc), (bar, D - 2 * bar, th), "M_CracTop", ch=0.3, ts=TS)
    g = T("Grille")
    ns = 56
    pitch = (W - 2 * bar) / ns
    for k in range(ns):
        g.cbox((-W / 2 + bar + pitch * (k + 0.5), 0, zt1 - 1.5), (1.0, D - 2 * bar, 3.0), "M_CracGrille", ch=0.15, ts=TS)
    T("Back").cbox((0, 0, zt0 + 0.3), (W - 2 * bar, D - 2 * bar, 0.6), "M_CracReturn", ts=TS)


def build() -> None:
    hp.setup_units()
    mats = make_materials()
    crah = hp.empty("CRAC", (0, 0, 0))  # prim 이름과 assetType은 옛 모델과 같다(장면, 계산, 웹이 그대로 읽는다)
    crah["assetType"] = "crac"
    objs: list = []
    build_parts(objs)
    hp.place(objs, mats, crah)
    hp.add_anchors(crah, (
        ("supply_temp", "degC", D / 2 + 5.0, 30.0),
        ("return_temp", "degC", 0.0, H + 5.0),
        ("fan_speed", "percent", -D / 2 - 5.0, H * 0.75),
    ))
    hp.report(objs, "CRAH")
    dg = bpy.context.evaluated_depsgraph_get()
    lo, hi = [1e9] * 3, [-1e9] * 3
    for ob in bpy.data.objects:
        if ob.type == "MESH":
            e = ob.evaluated_get(dg)
            me = e.to_mesh()
            for v in me.vertices:
                w = ob.matrix_world @ v.co
                for i in range(3):
                    lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
            e.to_mesh_clear()
    print("경계 상자 최소", [round(v, 3) for v in lo], "최대", [round(v, 3) for v in hi])


if __name__ == "__main__":
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "crah.blend"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build()
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print("저장:", out)
