"""장면 USD에서 OpenFOAM 사례 정의(메시 만들기 + 경계 + 랙 원천항)를 만든다. 시각화 목적의 비교용이다.

hall60_sim.py의 read_hall / Layout / crac_returns를 읽기만 해서 쓴다(수정하지 않음). 그래서 우리 솔버와 같은 칸 나눔, 같은 유량을 쓴다.

실행 (experiments/omniverse_probe 폴더에서):
    uv run --python 3.13 python ../openfoam_baseline/gen_case.py --scenario normal --out ../openfoam_baseline/cases/normal_dx10
옵션: --scenario normal|crac02_06_off, --dx 0.1(m), --no-buoyancy, --scheme upwind|linearUpwind, --power 10(kW), --iters 3000
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "omniverse_probe"))
import hall60_sim as h  # noqa: E402

HDR = """FoamFile
{{
    version     2.0;
    format      ascii;
    class       {cls};
    {loc}object      {obj};
}}
"""


def head(cls, obj, loc=None):
    return HDR.format(cls=cls, obj=obj, loc=f'location    "{loc}";\n    ' if loc else "")


def vec(v):
    return "(" + " ".join(f"{x:.6g}" for x in v) + ")"


class Box:
    """칸 인덱스 범위를 미터 좌표 상자로 바꾼다. 칸 중심만 들어오도록 0.01 m 줄인다."""

    def __init__(self, xs, xe, ys, ye, zs, ze, dx):
        self.lo = np.array([xs, ys, zs]) * dx + 0.01
        self.hi = np.array([xe, ye, ze]) * dx - 0.01


def voxel(item, dx, shape):
    (x0, y0, z0), (x1, y1, z1) = item["min"], item["max"]
    nx, ny, nz = shape
    xs, xe = h.rng(x0, x1, nx); ys, ye = h.rng(y0, y1, ny); zs, ze = h.rng(z0, z1, nz)
    return xs, xe, ys, ye, zs, ze


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="", help="normal 또는 crac02_06_off(기존 사례 이름). --fail을 쓰면 생략 가능")
    ap.add_argument("--fail", default=None, help="정지시킬 CRAC 이름(쉼표로 여러 대, 예: CRAC_03,CRAC_07). 빈 문자열이면 고장 없음")
    ap.add_argument("--scene", type=Path, default=None, help="장면 USD 경로(기본 usd/scenes/hall01.usda). 랙 배치를 바꾼 복사본도 가능")
    ap.add_argument("--dx", type=float, default=0.10)
    ap.add_argument("--no-buoyancy", action="store_true")
    ap.add_argument("--scheme", choices=["upwind", "linearUpwind"], default="upwind")
    ap.add_argument("--power", type=float, default=10.0, help="랙 1기 전력(kW). hall60_sim.py 기본값과 같다")
    ap.add_argument("--iters", type=int, default=3000)
    ap.add_argument("--conservative", action="store_true", help="수렴이 어려운 사례용: 이완 낮춤(U 0.5, p_rgh 0.2), 압력 잔차 기준 1e-3")
    ap.add_argument("--dflow", type=float, default=2e7, help="랙 흐름 방향 Darcy 저항 d(1/m^2)")
    ap.add_argument("--spec", type=Path, default=None, help="샘플 명세 JSON(surrogate/samples.json 또는 한 샘플). fan, row_power_kw, remove를 쓴다. --fail, --power, --scene보다 우선")
    ap.add_argument("--sample", default=None, help="--spec이 샘플 목록일 때 고를 id")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    h.DX = a.dx  # rng()와 Layout이 이 값을 읽는다
    scene = a.scene or (h.ROOT / "usd" / "scenes" / "hall01.usda")
    spec, tmp_scene = None, None
    if a.spec is not None:
        import json as _json
        import tempfile
        spec = _json.loads(a.spec.read_text(encoding="utf-8"))
        if isinstance(spec, dict) and "samples" in spec:
            spec = spec["samples"]
        if isinstance(spec, list):
            spec = next(x for x in spec if x["id"] == a.sample)
        if spec.get("remove"):
            import layout_whatif as lw  # 랙 제거는 layout_whatif.apply_edits와 같은 방식(장면 복사본, 원본은 수정하지 않음)
            tmp_scene = Path(tempfile.gettempdir()) / f"dct_gen_{spec['id']}.usda"
            lw.apply_edits(scene, tmp_scene, {"remove": list(spec["remove"])})
            scene = tmp_scene
    hall = h.read_hall(scene)
    lay = h.Layout(hall)
    nx, ny, nz = lay.shape
    dx = a.dx
    names = [c["name"] for c in hall["cracs"]]
    fan = np.ones(len(names), dtype=np.float32)
    fail = a.fail if a.fail is not None else ("CRAC_02,CRAC_06" if a.scenario == "crac02_06_off" else "")
    for n in [x.strip() for x in fail.split(",") if x.strip()]:
        fan[names.index(n)] = 0.0
    if spec is not None:
        fail = "spec"
        for n, v in spec["fan"].items():
            fan[names.index(n)] = float(v)
    # 랙별 전력(kW). 샘플 명세는 줄별 전력(랙 이름 번호로 줄을 정함: Rack_01~10 = 1번 줄)
    rack_kw = [a.power] * len(hall["racks"])
    if spec is not None:
        rack_kw = [float(spec["row_power_kw"][(int(r["name"].split("_")[1]) - 1) // 10]) for r in hall["racks"]]
    q, leak = h.crac_returns(lay, fan)
    supply = float(q.sum())
    out = a.out
    for d in ("0.orig", "constant", "system"):
        (out / d).mkdir(parents=True, exist_ok=True)

    # ---- 메시: 한 덩어리 격자 -> 고체 칸 제거 ----
    (out / "system/blockMeshDict").write_text(head("dictionary", "blockMeshDict") + f"""
vertices ( (0 0 0) ({nx*dx} 0 0) ({nx*dx} {ny*dx} 0) (0 {ny*dx} 0) (0 0 {nz*dx}) ({nx*dx} 0 {nz*dx}) ({nx*dx} {ny*dx} {nz*dx}) (0 {ny*dx} {nz*dx}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) simpleGrading (1 1 1) );
edges ();
boundary
(
    floor {{ type wall; faces ((0 3 2 1)); }}
    ceiling {{ type wall; faces ((4 5 6 7)); }}
    fixedWalls {{ type wall; faces ((0 4 7 3) (1 2 6 5) (0 1 5 4) (3 7 6 2)); }}
);
mergePatchPairs ();
""", encoding="utf-8")

    open_roofs = [aisle for aisle in range(lay.n_aisles) if leak[aisle] > 1e-9]
    roofs = sorted([p for p in hall["panels"] if p["name"].endswith("_Roof")], key=lambda p: p["min"][1])
    open_names = {roofs[i]["name"] for i in open_roofs}  # 새는 통로의 지붕은 열어 둔다(우리 모델의 '지붕 틈' 대응)
    solids = [c for c in hall["cracs"]] + [p for p in hall["panels"] if p["name"] not in open_names]

    def cell_action(name, kind, action, bx):
        return f"""    {{ name {name}; type {kind}; action {action}; source boxToCell; sourceInfo {{ box {vec(bx.lo)} {vec(bx.hi)}; }} }}\n"""

    s = head("dictionary", "topoSetDict") + "\nactions\n(\n"
    for i, it in enumerate(solids):
        s += cell_action("solid", "cellSet", "new" if i == 0 else "add", Box(*voxel(it, dx, lay.shape), dx))
    s += "    { name fluid; type cellSet; action new; source cellToCell; sourceInfo { set solid; } }\n"
    s += "    { name fluid; type cellSet; action invert; }\n);\n"
    (out / "system/topoSetDict.solid").write_text(s, encoding="utf-8")

    # 랙 영역(cellZone), 급기구 면, CRAC 회수 면
    s = head("dictionary", "topoSetDict") + "\nactions\n(\n"
    for i, r in enumerate(hall["racks"]):
        s += cell_action(f"rack_{i+1:02d}", "cellZoneSet", "new", Box(*voxel(r, dx, lay.shape), dx))
    n_cold = lay.n_cold
    first = [True] * n_cold
    for vi, v in enumerate(hall["vents"]):
        c = lay.vent_cold[vi]
        xs, xe, ys, ye, _, _ = voxel(v, dx, lay.shape)
        lo = (xs * dx + 0.01, ys * dx + 0.01, -0.01); hi = (xe * dx - 0.01, ye * dx - 0.01, 0.01)
        s += f"    {{ name vents_c{c}_f; type faceSet; action {'new' if first[c] else 'add'}; source boxToFace; sourceInfo {{ box {vec(lo)} {vec(hi)}; }} }}\n"
        first[c] = False
    # 급기 유량은 차가운 통로별로, 그 통로를 향한 랙 유량 비율로 나눈다(hall60_sim.source_field와 같은 규칙)
    demand = np.zeros(n_cold)
    for r_idx, c in enumerate(lay.rack_cold):
        demand[c] += lay.rack_flux[r_idx]
    vent_q = [supply * demand[c] / demand.sum() if demand.sum() > 0 else 0.0 for c in range(n_cold)]
    # decomposePar가 병렬 계산용 경계값을 유효숫자 7자리(writePrecision)로 다시 쓰므로, 풍량은 소수 4자리로 맞추고
    # 마지막 급기구가 나머지를 받게 해서 급기 합과 회수 합이 정확히 같게 한다(안 맞으면 첫 반복에서 연속 오류로 멈춘다).
    if demand.sum() > 0:
        vent_q = [round(x, 4) for x in vent_q]
        vent_q[-1] = round(sum(round(float(x), 4) for x in q) - sum(vent_q[:-1]), 4)
    crac_ret = []
    for i, c in enumerate(hall["cracs"]):
        if q[i] <= 0:
            continue
        xs, xe, ys, ye, zs, ze = voxel(c, dx, lay.shape)
        axis, sign = c["front"]
        zr0, zr1 = h.rng(h.RETURN_Z_CM[0], h.RETURN_Z_CM[1], nz)
        plane = (xe if sign > 0 else xs) * dx if axis == 0 else (ye if sign > 0 else ys) * dx
        if axis == 0:
            lo = (plane - 0.01, ys * dx + 0.01, zr0 * dx + 0.01); hi = (plane + 0.01, ye * dx - 0.01, zr1 * dx - 0.01)
        else:
            lo = (xs * dx + 0.01, plane - 0.01, zr0 * dx + 0.01); hi = (xe * dx - 0.01, plane + 0.01, zr1 * dx - 0.01)
        nm = f"crac_ret_{i+1:02d}"
        s += f"    {{ name {nm}_f; type faceSet; action new; source boxToFace; sourceInfo {{ box {vec(lo)} {vec(hi)}; }} }}\n"
        crac_ret.append((nm, float(q[i])))
    s += ");\n"
    (out / "system/topoSetDict.zones").write_text(s, encoding="utf-8")

    s = head("dictionary", "createPatchDict") + "\npointSync false;\npatches\n(\n"
    for c in range(lay.n_cold):
        s += f"    {{ name vents_c{c}; patchInfo {{ type patch; }} constructFrom set; set vents_c{c}_f; }}\n"
    for nm, _ in crac_ret:
        s += f"    {{ name {nm}; patchInfo {{ type patch; }} constructFrom set; set {nm}_f; }}\n"
    s += ");\n"
    (out / "system/createPatchDict").write_text(s, encoding="utf-8")

    # ---- 물성, 난류, 중력 ----
    (out / "constant/transportProperties").write_text(head("dictionary", "transportProperties") + """
transportModel Newtonian;
nu 1.5e-05;
beta 3e-03;
TRef 291.15;
Pr 0.71;
Prt 0.85;
""", encoding="utf-8")
    (out / "constant/turbulenceProperties").write_text(head("dictionary", "turbulenceProperties") + """
simulationType RAS;
RAS { RASModel kEpsilon; turbulence on; printCoeffs on; }
""", encoding="utf-8")
    g = "(0 0 0)" if a.no_buoyancy else "(0 0 -9.81)"
    (out / "constant/g").write_text(head("uniformDimensionedVectorField", "g", "constant") + f"\ndimensions [0 1 -2 0 0 0 0];\nvalue {g};\n", encoding="utf-8")

    # ---- 랙 원천항: 속도를 정해 둔 값으로 붙잡고(세게 당김), 같은 영역에 일정한 발열 ----
    # 랙 = 세게 막는 다공질(Darcy, 옆 방향 d_cross는 더 크게) + 목표 속도에서 저항과 균형을 이루는 일정한 힘(vectorSemiImplicitSource, 명시적)
    D_FLOW, D_CROSS = a.dflow, a.dflow * 20.0  # 1/m^2. 압력 손실 = nu*d*u*깊이
    NU = 1.5e-05  # transportProperties의 nu와 같게 둔다. 힘 = nu*d*목표속도: 목표 속도에서 저항과 정확히 균형(미리 계산한 힘)
    fo = head("dictionary", "fvOptions", "constant") + "\n"
    for i, (r, flux) in enumerate(zip(hall["racks"], lay.rack_flux)):
        axis, sign = r["front"]
        tgt = [0.0, 0.0, 0.0]; tgt[axis] = -sign * h.V_RACK
        rate = rack_kw[i] / (h.RHO_CP * flux) * (h.V_RACK / 1.0)  # K/s, hall60_sim.Sim.set_power와 같은 식
        z = f"rack_{i+1:02d}"
        fo += f"""{z}_por
{{
    type explicitPorositySource; active yes;
    explicitPorositySourceCoeffs
    {{
        selectionMode cellZone; cellZone {z}; type DarcyForchheimer;
        DarcyForchheimerCoeffs
        {{
            d d [0 -2 0 0 0 0 0] ({D_CROSS:g} {D_FLOW:g} {D_CROSS:g});
            f f [0 -1 0 0 0 0 0] (0 0 0);
            coordinateSystem {{ type cartesian; origin (0 0 0); coordinateRotation {{ type axesRotation; e1 (1 0 0); e2 (0 1 0); }} }}
        }}
    }}
}}
{z}_flow
{{
    type vectorSemiImplicitSource; active yes;
    vectorSemiImplicitSourceCoeffs {{ selectionMode cellZone; cellZone {z}; volumeMode specific; injectionRateSuSp {{ U ({vec([NU * D_FLOW * t for t in tgt])} 0); }} }}
}}
{z}_heat
{{
    type scalarSemiImplicitSource; active yes;
    scalarSemiImplicitSourceCoeffs {{ selectionMode cellZone; cellZone {z}; volumeMode specific; injectionRateSuSp {{ T ({rate:.6g} 0); }} }}
}}
"""
    (out / "constant/fvOptions").write_text(fo, encoding="utf-8")

    # ---- 초기값과 경계 ----
    def field(cls, obj, dims, internal, bounds, loc="0"):
        b = "".join(f"    {n}\n    {{\n{body}\n    }}\n" for n, body in bounds.items())
        return head(cls, obj, loc) + f"\ndimensions {dims};\ninternalField {internal};\nboundaryField\n{{\n{b}}}\n"

    walls = ("floor", "ceiling", "fixedWalls", "solidWalls")
    inlets = [f"vents_c{c}" for c in range(lay.n_cold)]
    outs = [n for n, _ in crac_ret]
    uvals = {}
    for w in walls:
        uvals[w] = "        type noSlip;"
    for c, nm in enumerate(inlets):
        uvals[nm] = f"        type flowRateInletVelocity;\n        volumetricFlowRate {vent_q[c]:.4f};\n        value uniform (0 0 0);"
    for n, qq in crac_ret:
        uvals[n] = f"        type flowRateInletVelocity;\n        volumetricFlowRate {-round(qq, 4):.4f};\n        value uniform (0 0 0);"
    (out / "0.orig/U").write_text(field("volVectorField", "U", "[0 1 -1 0 0 0 0]", "uniform (0 0 0)", uvals), encoding="utf-8")

    pv = {n: "        type fixedFluxPressure;\n        value uniform 0;" for n in (*walls, *inlets, *outs)}
    (out / "0.orig/p_rgh").write_text(field("volScalarField", "p_rgh", "[0 2 -2 0 0 0 0]", "uniform 0", pv), encoding="utf-8")
    (out / "0.orig/p").write_text(field("volScalarField", "p", "[0 2 -2 0 0 0 0]", "uniform 0", {n: "        type calculated;\n        value uniform 0;" for n in (*walls, *inlets, *outs)}), encoding="utf-8")

    tv = {w: "        type zeroGradient;" for w in walls}
    for nm in inlets:
        tv[nm] = f"        type fixedValue;\n        value uniform {h.T_SUPPLY + 273.15};"
    for n in outs:
        tv[n] = "        type zeroGradient;"
    (out / "0.orig/T").write_text(field("volScalarField", "T", "[0 0 0 1 0 0 0]", f"uniform {h.T_INIT + 273.15}", tv), encoding="utf-8")

    kv = {w: "        type kqRWallFunction;\n        value uniform 0.05;" for w in walls}
    for nm in inlets:
        kv[nm] = "        type turbulentIntensityKineticEnergyInlet;\n        intensity 0.05;\n        value uniform 0.05;"
    for n in outs:
        kv[n] = "        type zeroGradient;"
    (out / "0.orig/k").write_text(field("volScalarField", "k", "[0 2 -2 0 0 0 0]", "uniform 0.05", kv), encoding="utf-8")
    ev = {w: "        type epsilonWallFunction;\n        value uniform 0.05;" for w in walls}
    for nm in inlets:
        ev[nm] = "        type turbulentMixingLengthDissipationRateInlet;\n        mixingLength 0.05;\n        value uniform 0.05;"
    for n in outs:
        ev[n] = "        type zeroGradient;"
    (out / "0.orig/epsilon").write_text(field("volScalarField", "epsilon", "[0 2 -3 0 0 0 0]", "uniform 0.05", ev), encoding="utf-8")
    nv = {w: "        type nutkWallFunction;\n        value uniform 0;" for w in walls}
    for n in (*inlets, *outs):
        nv[n] = "        type calculated;\n        value uniform 0;"
    (out / "0.orig/nut").write_text(field("volScalarField", "nut", "[0 2 -1 0 0 0 0]", "uniform 0", nv), encoding="utf-8")
    av = {w: "        type alphatJayatillekeWallFunction;\n        Prt 0.85;\n        value uniform 0;" for w in walls}
    for n in (*inlets, *outs):
        av[n] = "        type calculated;\n        value uniform 0;"
    (out / "0.orig/alphat").write_text(field("volScalarField", "alphat", "[0 2 -1 0 0 0 0]", "uniform 0", av), encoding="utf-8")

    # ---- 수치 방식과 제어 ----
    if a.scheme == "upwind":
        div_u, div_t = "bounded Gauss upwind", "bounded Gauss upwind"
    else:
        div_u, div_t = "bounded Gauss linearUpwind grad(U)", "bounded Gauss limitedLinear 1"
    (out / "system/fvSchemes").write_text(head("dictionary", "fvSchemes", "system") + f"""
ddtSchemes {{ default steadyState; }}
gradSchemes {{ default Gauss linear; }}
divSchemes
{{
    default none;
    div(phi,U) {div_u};
    div(phi,T) {div_t};
    div(phi,k) bounded Gauss upwind;
    div(phi,epsilon) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}}
laplacianSchemes {{ default Gauss linear corrected; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default corrected; }}
wallDist {{ method meshWave; }}
""", encoding="utf-8")
    # 기본(기준 사례): 이완 U 0.7. --conservative(샘플 40개 배치): 줄별 전력이 다르면 초반에 발산(FPE)해서 이완을 낮추고, 압력 잔차 기준을 1e-3으로 둔다(1e-4에서 4e-4로 멈춤)
    if a.conservative:
        relax_f, relax_e, p_res = "0.2", ("0.5", "0.8", "0.5"), "1e-3"
    else:
        relax_f, relax_e, p_res = "0.3", ("0.7", "0.9", "0.7"), "1e-4"
    (out / "system/fvSolution").write_text((head("dictionary", "fvSolution", "system") + """
solvers
{
    p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-08; relTol 0.05; }
    "(U|T|k|epsilon)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-08; relTol 0.1; }
}
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    pRefCell 0;
    pRefValue 0;
    residualControl { p_rgh @PRES@; U 1e-5; T 1e-6; "(k|epsilon)" 1e-5; }
}
relaxationFactors
{
    fields { p_rgh @RF@; }
    equations { U @RU@; T @RT@; "(k|epsilon)" @RK@; }
}
""").replace("@PRES@", p_res).replace("@RF@", relax_f).replace("@RU@", relax_e[0]).replace("@RT@", relax_e[1]).replace("@RK@", relax_e[2]), encoding="utf-8")
    (out / "system/controlDict").write_text(head("dictionary", "controlDict", "system") + f"""
application buoyantBoussinesqSimpleFoam;
startFrom latestTime;
startTime 0;
stopAt endTime;
endTime {a.iters};
deltaT 1;
writeControl timeStep;
writeInterval {a.iters};
purgeWrite 1;
writeFormat ascii;
writePrecision 7;
timeFormat general;
timePrecision 6;
runTimeModifiable false;
""", encoding="utf-8")
    (out / "system/decomposeParDict").write_text(head("dictionary", "decomposeParDict", "system") + "\nnumberOfSubdomains 16;\nmethod hierarchical;\nhierarchicalCoeffs { n (2 4 2); order xyz; }\n", encoding="utf-8")
    solid_only = np.zeros(lay.shape, dtype=bool)
    for it in solids:
        xs, xe, ys, ye, zs, ze = voxel(it, dx, lay.shape)
        solid_only[xs:xe, ys:ye, zs:ze] = True
    np.savez_compressed(out / "case_voxels.npz", shape=np.array(lay.shape), dx=dx, solid=np.packbits(solid_only.ravel(order="F")))
    meta = {
        "scenario": a.scenario or fail, "fail": fail, "scene": str(scene), "racks": len(hall["racks"]), "vent_supply_m3s_per_cold_aisle": [round(x, 3) for x in vent_q], "dx": dx, "cells_total": int(np.prod(lay.shape)), "cells_fluid": int(lay.fluid.sum()),
        "crac_return_m3s": {n: round(float(x), 3) for n, x in zip(names, q)}, "supply_m3s": round(supply, 3),
        "open_roofs": sorted(open_names), "power_kw": a.power, "total_power_kw": float(sum(rack_kw)), "fan": {n: float(v) for n, v in zip(names, fan)}, "sample": spec["id"] if spec else None, "buoyancy": not a.no_buoyancy, "conservative_relaxation": a.conservative, "scheme": a.scheme,
        "darcy_d_flow_1_m2": D_FLOW, "darcy_d_cross_1_m2": D_CROSS,
    }
    import json
    (out / "case_layout.json").write_text(json.dumps(hall, ensure_ascii=False, default=float), encoding="utf-8")
    (out / "case_meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    if tmp_scene is not None:
        tmp_scene.unlink(missing_ok=True)
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
