"""Flow 프리셋의 모든 속성과 값을 덤프한다 (온도 의미 확인용)."""
import asyncio, json, traceback
import omni.kit.app, omni.kit.commands, omni.usd
from pxr import UsdGeom
OUT = "D:/Test/experiments/omniverse_probe/out/kit/flow_anchors/probe_attrs.json"
res = {}
async def main():
    app = omni.kit.app.get_app()
    try:
        for _ in range(30): await app.next_update_async()
        app.get_extension_manager().set_extension_enabled_immediate("omni.flowusd", True)
        for _ in range(30): await app.next_update_async()
        ctx = omni.usd.get_context(); await ctx.new_stage_async(); st = ctx.get_stage()
        UsdGeom.SetStageMetersPerUnit(st, 1.0)
        UsdGeom.Xform.Define(st, "/World"); UsdGeom.Xform.Define(st, "/World/Heat")
        omni.kit.commands.execute("FlowCreatePresets", preset_name="Fire", paths=["/World/Heat"])
        for _ in range(20): await app.next_update_async()
        for p in st.Traverse():
            t = str(p.GetTypeName())
            if "Flow" in t:
                res[str(p.GetPath())] = {"type": t, "attrs": {a.GetName(): (str(a.Get()), a.GetDocumentation()[:300]) for a in p.GetAttributes()}}
    except Exception:
        res["fatal"] = traceback.format_exc(); print(res["fatal"])
    finally:
        open(OUT, "w", encoding="utf-8").write(json.dumps(res, indent=1, ensure_ascii=False))
        app.post_quit()
asyncio.ensure_future(main())
