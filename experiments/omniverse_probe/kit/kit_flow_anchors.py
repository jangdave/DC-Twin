"""소형 실험: Flow(omni.flowusd)로 Row01 랙 10기 뒤쪽에서 열을 내고, 온도 채널(OpenVDB 내보내기)을
센서 앵커(TEMP-IN/TEMP-OUT) 위치에서 읽어 CSV로 저장한다. 시각화 목적이며 공학적 정확성은 주장하지 않는다.

환경 변수: DCT_FRAMES(기본 240), DCT_READ_ONLY=1(시뮬레이션 없이 남은 .vdb만 읽기), DCT_KEEP=1(.vdb 보관),
DCT_CELL(셀 크기 m, 기본 0.1), DCT_EMIT_T(방출 온도, 기본 2.0), DCT_COMB(1이면 연소 켬)
결과: out/kit/flow_anchors/flow_anchors.csv, flow_anchors_summary.json
"""
from __future__ import annotations

import asyncio
import csv
import json
import os
import re
import time
import traceback
from pathlib import Path

import omni.kit.app
import omni.kit.commands
import omni.timeline
import omni.usd
from pxr import Gf, Sdf, Usd, UsdGeom

OUT = Path("D:/Test/experiments/omniverse_probe/out/kit/flow_anchors")
VDB = OUT / "vdb"
SCENE = "D:/Test/usd/scenes/hall01.usda"
FRAMES = int(os.environ.get("DCT_FRAMES", "240"))
READ_ONLY = os.environ.get("DCT_READ_ONLY", "0") == "1"
KEEP = os.environ.get("DCT_KEEP", "0") == "1"
CELL = float(os.environ.get("DCT_CELL", "0.1"))
EMIT_T = float(os.environ.get("DCT_EMIT_T", "2.0"))
ONLY = os.environ.get("DCT_ONLY", "")  # 예: RK03 -> 그 랙 방출기만 (좌표 확인용)
COMB = os.environ.get("DCT_COMB", "0") == "1"
OUT.mkdir(parents=True, exist_ok=True)
VDB.mkdir(parents=True, exist_ok=True)
res: dict = {"frames_requested": FRAMES, "cell_m": CELL, "emit_temperature": EMIT_T, "combustion": COMB}


def anchors():
    st = Usd.Stage.Open(SCENE)
    cache = UsdGeom.XformCache()
    out = {}
    for p in st.Traverse():
        s = str(p.GetPath())
        if s.startswith("/DC/Hall01/Row01/Rack_") and "/Anchors/Sensor_TEMP_" in s:
            sid = p.GetAttribute("dct:sensorId").Get()
            t = cache.GetLocalToWorldTransform(p).ExtractTranslation()
            out[sid] = (t[0] / 100.0, t[1] / 100.0, t[2] / 100.0)  # cm -> m
    return out


def frame_no(f: Path) -> int:
    return int(re.findall(r"_(\d+)\.vdb$", f.name)[0])


def read_vdbs(pos: dict):
    import openvdb as vdb

    files = sorted(VDB.glob("FlowTemperature*.vdb"), key=frame_no)
    res["vdb_count"] = len(files)
    res["vdb_total_mb"] = round(sum(f.stat().st_size for f in files) / 1e6, 2)
    rows = []
    # 가정: 내보낸 격자의 원점 = 방출기 무리의 중심 (한 개 방출기 실험에서 열 구름의 중심이 원점이었다)
    outs = [v for k, v in pos.items() if k.endswith("TEMP-OUT")]
    ins = [v for k, v in pos.items() if k.endswith("TEMP-IN")]
    sgn = 1.0 if outs[0][1] >= ins[0][1] else -1.0
    off = (sum(v[0] for v in outs) / len(outs), sum(v[1] for v in outs) / len(outs) + sgn * 0.15, 1.0)
    res["assumed_grid_origin_world_m"] = [round(c, 3) for c in off]
    for i, f in enumerate(files):
        try:
            names = [g.name for g in vdb.readAllGridMetadata(str(f))]
        except Exception as e:  # noqa: BLE001
            names = f"meta err {e}"
        if i == 0:
            res["grid_names_first"] = names
            res["openvdb_attrs"] = [a for a in dir(vdb) if not a.startswith("_")][:60]
        g = vdb.read(str(f), names[0] if isinstance(names, list) and names else "temperature")
        if i == 0:
            res["voxel_size_m"] = float(g.transform.voxelSize()[0])
            res["grid_class"] = type(g).__name__
            res["background"] = float(g.background)
            res["grid_attrs"] = [a for a in dir(g) if not a.startswith("_")]
            res["transform_attrs"] = [a for a in dir(g.transform) if not a.startswith("_")]
            try:
                bb = g.evalActiveVoxelBoundingBox()
                res["bbox_first"] = [list(bb[0]), list(bb[1])]
            except Exception as e:  # noqa: BLE001
                res["bbox_err"] = str(e)
            try:
                tr = g.transform
                res["index_to_world_bbox_min"] = [round(c, 3) for c in tr.indexToWorld(tuple(bb[0]))]
                res["index_to_world_bbox_max"] = [round(c, 3) for c in tr.indexToWorld(tuple(bb[1]))]
                best = max(g.citerOnValues(), key=lambda it: it.value)
                res["argmax_coord_first"] = list(best.min)
                res["metadata"] = {k: str(g[k]) for k in (g.keys() if hasattr(g, "keys") else [])}
            except Exception as e:  # noqa: BLE001
                res["xf_err"] = str(e)[:200]
        acc = g.getConstAccessor() if hasattr(g, "getConstAccessor") else g.getAccessor()
        row = {"file": f.name, "frame_no": frame_no(f)}
        try:
            row["active_voxels"] = int(g.activeVoxelCount())
        except Exception:  # noqa: BLE001
            pass
        for sid, xyz0 in pos.items():
            xyz = (xyz0[0] - off[0], xyz0[1] - off[1], xyz0[2] - off[2])
            tr = g.transform
            ijk = tr.worldToIndexCellCentered(xyz) if hasattr(tr, "worldToIndexCellCentered") else tr.worldToIndex(xyz)
            ijk = tuple(int(round(c)) for c in ijk)
            v = [acc.getValue((ijk[0] + a, ijk[1] + b, ijk[2] + c)) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1)]
            row[sid] = float(sum(v) / len(v))
        try:
            best = max(g.citerOnValues(), key=lambda it: it.value)
            row["grid_max"] = float(best.value)
            row["argmax_ijk"] = " ".join(str(c) for c in best.min)
        except Exception as e:  # noqa: BLE001
            row["grid_max_err"] = str(e)[:80]
        if i == len(files) - 1:
            # 마지막 프레임: 온도 0.5 이상 칸의 무게중심(칸 번호 기준). 격자 원점이 어디에 있는지 가늠하는 용도
            sw = sx = sy = sz = 0.0
            for it in g.citerOnValues():
                if it.value > 0.5:
                    c = it.min
                    sw += 1; sx += c[0]; sy += c[1]; sz += c[2]
            if sw:
                res["last_frame_hot_centroid_ijk"] = [round(sx / sw, 2), round(sy / sw, 2), round(sz / sw, 2)]
                res["last_frame_hot_voxels"] = int(sw)
        rows.append(row)
    return rows


async def main() -> None:
    app = omni.kit.app.get_app()
    try:
        pos = anchors()
        res["anchors_m"] = {k: [round(c, 3) for c in v] for k, v in pos.items()}
        for _ in range(30):
            await app.next_update_async()
        app.get_extension_manager().set_extension_enabled_immediate("omni.flowusd", True)
        app.get_extension_manager().set_extension_enabled_immediate("omni.volume", True)
        for _ in range(30):
            await app.next_update_async()
        if not READ_ONLY:
            for old in VDB.glob("*"):
                old.unlink()
            ctx = omni.usd.get_context()
            await ctx.new_stage_async()
            st = ctx.get_stage()
            UsdGeom.SetStageMetersPerUnit(st, 1.0)
            UsdGeom.SetStageUpAxis(st, UsdGeom.Tokens.z)
            world = UsdGeom.Xform.Define(st, "/World")
            st.SetDefaultPrim(world.GetPrim())
            UsdGeom.Xform.Define(st, "/World/Heat")
            omni.kit.commands.execute("FlowCreatePresets", preset_name="Fire", paths=["/World/Heat"])
            for _ in range(30):
                await app.next_update_async()
            fire = "/World/Heat/Fire"
            st.GetPrimAtPath(fire + "/flowEmitterSphere").GetAttribute("enabled").Set(False)
            outs = {k: v for k, v in pos.items() if k.endswith("TEMP-OUT")}
            ins = {k: v for k, v in pos.items() if k.endswith("TEMP-IN")}
            created = 0
            for sid, (x, y, z) in outs.items():
                rk = sid.split("-")[1]
                if ONLY and rk not in ONLY.split(","):
                    continue
                ix, iy, iz = ins[sid.replace("OUT", "IN")]
                d = Gf.Vec3d(x - ix, y - iy, 0.0)
                d = d.GetNormalized() if d.GetLength() > 0 else d
                e = st.DefinePrim(f"{fire}/emit_{rk}", "FlowEmitterSphere")

                def sa(n, t, v, e=e):
                    a = e.GetAttribute(n) or e.CreateAttribute(n, t)
                    a.Set(v)

                sa("position", Sdf.ValueTypeNames.Float3, Gf.Vec3f(x + d[0] * 0.15, y + d[1] * 0.15, 1.0))
                sa("radius", Sdf.ValueTypeNames.Float, 0.3)
                sa("temperature", Sdf.ValueTypeNames.Float, EMIT_T)
                sa("coupleRateTemperature", Sdf.ValueTypeNames.Float, 10.0)
                sa("fuel", Sdf.ValueTypeNames.Float, 0.0)
                sa("coupleRateFuel", Sdf.ValueTypeNames.Float, 0.0)
                sa("velocity", Sdf.ValueTypeNames.Float3, Gf.Vec3f(d[0], d[1], 0.0))
                sa("coupleRateVelocity", Sdf.ValueTypeNames.Float, 2.0)
                sa("smoke", Sdf.ValueTypeNames.Float, 1.0)  # 칸 할당이 연기 기준이라 약간의 연기를 같이 낸다
                sa("coupleRateSmoke", Sdf.ValueTypeNames.Float, 2.0)
                sa("layer", Sdf.ValueTypeNames.Int, 1)
                sa("enabled", Sdf.ValueTypeNames.Bool, True)
                created += 1
            res["emitters_created"] = created
            st.GetPrimAtPath(fire + "/flowSimulate").GetAttribute("densityCellSize").Set(CELL)
            adv = st.GetPrimAtPath(fire + "/flowSimulate/advection")
            adv.GetAttribute("gravity").Set(Gf.Vec3f(0, 0, -100))
            adv.GetAttribute("combustionEnabled").Set(COMB)
            ex = st.GetPrimAtPath(fire + "/flowSimulate/nanoVdbExport")
            for k, v in (("enabled", True), ("temperatureEnabled", True), ("smokeEnabled", False), ("velocityEnabled", False),
                         ("readbackEnabled", True), ("readbackOpenVDB", True), ("readbackClearOnStart", False), ("readbackClearOnStop", False)):
                ex.GetAttribute(k).Set(v)
            ex.GetAttribute("readbackDirectory").Set(Sdf.AssetPath(VDB.as_posix()))
            tl = omni.timeline.get_timeline_interface()
            tl.set_end_time(30.0)
            tl.play()
            t0 = time.perf_counter()
            for _ in range(FRAMES):
                await app.next_update_async()
            tl.pause()
            for _ in range(10):
                await app.next_update_async()
            res["sim_wall_s"] = round(time.perf_counter() - t0, 1)
            res["timeline_s"] = round(tl.get_current_time(), 3)
        t1 = time.perf_counter()
        rows = read_vdbs(pos)
        res["read_wall_s"] = round(time.perf_counter() - t1, 1)
        keys = sorted(pos)
        with open(OUT / "flow_anchors.csv", "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["frame_no"] + keys + ["grid_max", "active_voxels", "argmax_ijk"])
            for r in rows:
                w.writerow([r["frame_no"]] + [round(r.get(k, float("nan")), 5) for k in keys] + [r.get("grid_max"), r.get("active_voxels"), r.get("argmax_ijk")])
        res["rows"] = len(rows)
        if rows:
            res["last_frame_values"] = {k: round(rows[-1][k], 4) for k in keys}
            res["last_grid_max"] = rows[-1].get("grid_max")
        if not KEEP:
            for f in VDB.glob("*.vdb"):
                f.unlink()
    except Exception:  # noqa: BLE001
        res["fatal"] = traceback.format_exc()
        print(res["fatal"], flush=True)
    finally:
        (OUT / "flow_anchors_summary.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
        print("[kit_flow_anchors] done", {k: v for k, v in res.items() if k not in ("anchors_m", "openvdb_attrs", "grid_attrs", "transform_attrs")}, flush=True)
        app.post_quit()


asyncio.ensure_future(main())
