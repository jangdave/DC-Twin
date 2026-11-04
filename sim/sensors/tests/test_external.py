"""외부 CFD 결과(VTK) 변환 파이프라인 시험. 실제 외부 도구의 파일이 아니라 이 저장소가 만든 합성 파일로 확인한다."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from dct_sensors.api import DataApi
from dct_sensors.external import vtk_legacy, writer
from dct_sensors.external.__main__ import main as cli
from dct_sensors.external.mapping import Mapping, MappingError, pick_field, sample_nearest
from dct_sensors.external.pack import PackError, build_case, ensure_ignored, write_pack

REPO = Path(__file__).resolve().parents[3]
WEB_DATA = REPO / "web" / "viewer" / "public" / "data"
ANCHORS = REPO / "server" / "data" / "anchors.json"
needs_data = pytest.mark.skipif(not (WEB_DATA / "sensors.json").exists() or not ANCHORS.exists(), reason="웹 자료나 앵커 파일이 없음")
ORIGINS = [None, re.compile(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$")]


# ---- VTK 읽기 ----
@pytest.mark.parametrize("binary", [False, True])
def test_structured_points_roundtrip(binary):
    dims = (4, 3, 2)
    t = np.arange(24, dtype=float) * 0.5 + 10
    ds = vtk_legacy.parse(writer.structured_points(dims, (1.0, 2.0, 3.0), (0.5, 0.5, 1.0), {"T": t}, binary=binary))
    assert ds.kind == "STRUCTURED_POINTS" and ds.binary is binary and ds.dims == dims and ds.n_points == 24
    assert np.allclose(ds.point_data["T"], t)
    assert np.allclose(ds.points[0], [1.0, 2.0, 3.0]) and np.allclose(ds.points[1], [1.5, 2.0, 3.0])  # x가 가장 빨리 변한다
    assert np.allclose(ds.points[4], [1.0, 2.5, 3.0]) and np.allclose(ds.points[12], [1.0, 2.0, 4.0])


@pytest.mark.parametrize("binary", [False, True])
def test_rectilinear_grid(binary):
    xs, ys, zs = [0.0, 1.0, 3.0], [0.0, 2.0], [5.0, 6.0, 8.0, 9.0]
    n = len(xs) * len(ys) * len(zs)
    ds = vtk_legacy.parse(writer.rectilinear_grid(xs, ys, zs, {"T": np.arange(n, dtype=float)}, binary=binary))
    assert ds.n_points == n and np.allclose(ds.points[2], [3.0, 0.0, 5.0]) and np.allclose(ds.points[-1], [3.0, 2.0, 9.0])


@pytest.mark.parametrize("binary,new_style", [(False, False), (True, False), (False, True), (True, True)])
def test_unstructured_hexes_cell_data_like_openfoam(binary, new_style):
    pts, hexes = writer.box_hex_mesh(3, 2, 2, (3.0, 2.0, 2.0))
    t = np.arange(len(hexes), dtype=float) + 20
    ds = vtk_legacy.parse(writer.unstructured_hexes(pts, hexes, cell_scalars={"T": t}, binary=binary, new_style=new_style))
    assert len(ds.cells) == 12 and ds.cells[0].tolist() == hexes[0].tolist()
    centers = ds.cell_centers()
    assert np.allclose(centers[0], [0.5, 0.5, 0.5]) and np.allclose(centers[-1], [2.5, 1.5, 1.5])
    assert np.allclose(ds.cell_data["T"], t)


def test_structured_grid_points():
    pts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], dtype=float)
    raw = b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET STRUCTURED_GRID\nDIMENSIONS 2 2 1\nPOINTS 4 float\n" + b"\n".join(b"%g %g %g" % tuple(p) for p in pts) + b"\nPOINT_DATA 4\nSCALARS T float 1\nLOOKUP_TABLE default\n1 2 3 4\n"
    ds = vtk_legacy.parse(raw)
    assert ds.kind == "STRUCTURED_GRID" and np.allclose(ds.point_data["T"], [1, 2, 3, 4])


def test_field_array_and_vectors_are_read():
    raw = writer.structured_points((2, 1, 1), (0, 0, 0), (1, 1, 1), {"T": np.array([1.0, 2.0])})
    raw += b"VECTORS U float\n1 0 0\n0 2 0\nFIELD FieldData 1\nk 1 2 float\n7 8\n"
    ds = vtk_legacy.parse(raw)
    assert ds.point_data["U"].shape == (2, 3) and np.allclose(ds.point_data["k"], [7, 8])


@pytest.mark.parametrize("raw,msg", [
    (b"not a vtk file", "레거시 VTK"),
    (b"<?xml version='1.0'?><VTKFile>", "레거시 VTK"),
    (b"# vtk DataFile Version 3.0\nx\nBINARY2\nDATASET STRUCTURED_POINTS\n", "ASCII나 BINARY"),
    (b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET POLYDATA\n", "지원하지 않는 데이터셋"),
    (b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET STRUCTURED_POINTS\nDIMENSIONS 2 2 2\nPOINT_DATA 8\nSCALARS T float 1\nLOOKUP_TABLE default\n1 2 3\n", "모자란다"),
    (b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET UNSTRUCTURED_GRID\nBOGUS 1\n", "알 수 없는 줄"),
    (b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET UNSTRUCTURED_GRID\nCELLS 1 2\n1 0\n", "점 좌표"),
])
def test_bad_files_give_clear_errors(raw, msg):
    with pytest.raises(vtk_legacy.VtkError, match=msg):
        vtk_legacy.parse(raw)


def test_truncated_binary_is_detected():
    raw = writer.structured_points((3, 3, 3), (0, 0, 0), (1, 1, 1), {"T": np.zeros(27)}, binary=True)
    with pytest.raises(vtk_legacy.VtkError, match="모자란다"):
        vtk_legacy.parse(raw[:-40])


def test_describe_lists_fields_and_range():
    ds = vtk_legacy.parse(writer.structured_points((2, 2, 2), (0, 0, 0), (1, 1, 1), {"T": np.linspace(290, 300, 8)}))
    text = vtk_legacy.describe(ds)
    assert "점 8개" in text and "점 값 T" in text and "290~300" in text and "단위는 파일에 없다" in text


# ---- 매핑 ----
def test_mapping_defaults_and_validation():
    m = Mapping.from_dict({})
    assert (m.unit, m.axes, m.field, m.temperature_unit) == ("m", ("x", "y", "z"), "T", "C")
    for bad, msg in [({"unitt": "m"}, "알 수 없는 항목"), ({"unit": "ft"}, "unit은"), ({"axes": ["x", "x", "z"]}, "axes는"), ({"origin_cm": [1, 2]}, "origin_cm"),
                     ({"temperature_unit": "F"}, "temperature_unit"), ({"max_distance_cm": 0}, "max_distance_cm"), ({"case": {"bogus": 1}}, "case에는"), ({"location": "edge"}, "location"),
                     ({"tool": ""}, "tool은"), ([], "JSON 객체")]:
        with pytest.raises(MappingError, match=msg):
            Mapping.from_dict(bad)


def test_to_hall_cm_applies_unit_axes_and_origin():
    m = Mapping.from_dict({"unit": "m", "axes": ["y", "-x", "z"], "origin_cm": [10, 20, 30]})
    out = m.to_hall_cm(np.array([[1.0, 2.0, 3.0]]))
    assert np.allclose(out, [[200 + 10, -100 + 20, 300 + 30]])
    assert np.allclose(Mapping.from_dict({"unit": "mm"}).to_hall_cm(np.array([[100.0, 0, 0]])), [[10, 0, 0]])


def test_kelvin_to_celsius():
    assert np.allclose(Mapping.from_dict({"temperature_unit": "K"}).to_celsius(np.array([293.15])), [20.0])


def test_pick_field_point_cell_auto_and_errors():
    pts, hexes = writer.box_hex_mesh(2, 2, 2, (2, 2, 2))
    ds = vtk_legacy.parse(writer.unstructured_hexes(pts, hexes, cell_scalars={"T": np.arange(8.0)}))
    v, p = pick_field(ds, "T", "auto")
    assert len(v) == len(p) == 8  # 셀 값이므로 셀 중심
    with pytest.raises(MappingError, match="값 이름 'X'을 찾지 못했다.*T"):
        pick_field(ds, "X", "auto")
    with pytest.raises(MappingError):
        pick_field(ds, "T", "point")
    ds2 = vtk_legacy.parse(writer.structured_points((2, 1, 1), (0, 0, 0), (1, 1, 1), {"T": np.array([1.0, 2.0])}) + b"VECTORS U float\n1 0 0\n0 1 0\n")
    with pytest.raises(MappingError, match="성분이 3개"):
        pick_field(ds2, "U", "point")


def test_sample_nearest_and_cutoff():
    pts = np.array([[0, 0, 0], [100, 0, 0]], dtype=float)
    v, d = sample_nearest(pts, np.array([10.0, 20.0]), np.array([[10, 0, 0], [90, 0, 0], [500, 0, 0]]), 30)
    assert v[0] == 10.0 and v[1] == 20.0 and np.isnan(v[2]) and np.allclose(d[:2], [10, 10])


# ---- 묶음 만들기 ----
def linear_field_vtk(path: Path):
    """온도가 위치(cm)에 선형인 합성 장: T = 10 + 0.01 x + 0.002 y + 0.001 z. 값이 위치에서 정해져 앵커 값을 예측할 수 있다."""
    size = json.loads(ANCHORS.read_text(encoding="utf-8"))["size_cm"]
    sp = 10.0
    dims = tuple(int(np.ceil(s / sp)) + 1 for s in size)
    xs, ys, zs = (np.arange(d) * sp for d in dims)
    gz, gy, gx = np.meshgrid(zs, ys, xs, indexing="ij")
    t = 10 + 0.01 * gx + 0.002 * gy + 0.001 * gz
    path.write_bytes(writer.structured_points(dims, (0, 0, 0), (sp / 100,) * 3, {"T": t.ravel()}, binary=True))


def inputs():
    sensors = json.loads((WEB_DATA / "sensors.json").read_text(encoding="utf-8"))
    anchors = json.loads(ANCHORS.read_text(encoding="utf-8"))
    baseline = json.loads((WEB_DATA / "rec" / "normal.json").read_text(encoding="utf-8"))
    return sensors, anchors, baseline


@needs_data
def test_build_case_samples_anchors_and_fills_the_rest(tmp_path):
    vtk = tmp_path / "lin.vtk"
    linear_field_vtk(vtk)
    sensors, anchors, baseline = inputs()
    m = Mapping.from_dict({"tool": "합성", "case": {"rack_power_kw": 8.0, "supply_temp": 18.0}})
    rec, entry = build_case(vtk, m, sensors, anchors, baseline, "ext_lin", "선형 장", "시험")
    # 앵커 값이 장에서 예측한 값과 같다(격자 10 cm라 가장 가까운 점과의 어긋남은 최대 약 0.1도)
    a = next(x for x in anchors["anchors"] if x["equipment"] == "rack_05" and x["metric"] == "temp_in")
    x, y, z = a["pos_cm"]
    expect = 10 + 0.01 * x + 0.002 * y + 0.001 * z
    sid = next(s["sensorId"] for s in sensors if s["equipment"] == "rack_05" and s["metric"] == "temp_in")
    assert abs(rec["values"][sid][0] - expect) < 0.12 and len(set(rec["values"][sid])) == 1 and len(rec["values"][sid]) == 300
    assert rec["meta"]["coverage"]["anchors"] == 60 * 2 + 8 and rec["meta"]["coverage"]["maxDistanceCm"] <= 9
    # 전력은 case, 팬 속도는 기준 녹화, 급기 온도는 case
    assert rec["meta"]["filled"]["rack/power"] == "case" and rec["meta"]["filled"]["crac/fan_speed"] == "baseline"
    assert rec["meta"]["filled"]["rack/temp_in"] == "cfd" and rec["meta"]["filled"]["crac/supply_temp"] == "case"
    pw = next(s["sensorId"] for s in sensors if s["equipment"] == "rack_05" and s["metric"] == "power")
    assert rec["values"][pw][0] == 8.0 and rec["aggregates"]["it_power"][0] == 480.0
    assert abs(rec["aggregates"]["facility_power"][0] - (480 * 1.06 + rec["aggregates"]["cooling_power"][0])) < 0.01
    assert entry["group"] == "external" and entry["source"] == "external" and entry["id"] == "ext_lin"
    assert set(rec["values"]) == {s["sensorId"] for s in sensors}


@needs_data
def test_alarms_follow_the_same_rules_as_the_generator(tmp_path):
    """온도가 주의 기준(입구 27도)을 넘는 장이면 알람이 생기고, 연속 2번째 값에서 올라간다."""
    size = json.loads(ANCHORS.read_text(encoding="utf-8"))["size_cm"]
    dims = tuple(int(np.ceil(s / 20)) + 1 for s in size)
    vtk = tmp_path / "hot.vtk"
    vtk.write_bytes(writer.structured_points(dims, (0, 0, 0), (0.2, 0.2, 0.2), {"T": np.full(int(np.prod(dims)), 30.0)}, binary=True))
    sensors, anchors, baseline = inputs()
    rec, _ = build_case(vtk, Mapping.from_dict({"max_distance_cm": 30}), sensors, anchors, baseline, "ext_hot", "더움", "")
    ins = {s["sensorId"] for s in sensors if s["metric"] == "temp_in"}
    hot = [a for a in rec["alarms"] if a["sensorId"] in ins]
    assert len(hot) == 60 and all(a["to"] == "warn" and a["t"] == 1 and a["from"] == "normal" for a in hot)  # 30도는 주의(27)와 위험(32) 사이


@needs_data
def test_wrong_coordinates_fail_with_a_hint(tmp_path):
    vtk = tmp_path / "far.vtk"
    vtk.write_bytes(writer.structured_points((3, 3, 3), (500, 500, 500), (1, 1, 1), {"T": np.zeros(27)}))  # 홀에서 아주 먼 곳
    sensors, anchors, baseline = inputs()
    with pytest.raises(PackError, match=r"변환한 데이터 범위.*mapping의 unit, axes, origin_cm"):
        build_case(vtk, Mapping.from_dict({}), sensors, anchors, baseline, "ext_far", "x", "")


@needs_data
def test_axes_origin_and_kelvin_mapping_recover_the_same_field(tmp_path):
    """도구의 좌표가 mm이고 Y가 뒤집히고 원점이 다르고 켈빈이어도, mapping으로 같은 앵커 값을 얻는다."""
    size = json.loads(ANCHORS.read_text(encoding="utf-8"))["size_cm"]
    sp = 10.0
    dims = tuple(int(np.ceil(s / sp)) + 1 for s in size)
    xs, ys, zs = (np.arange(d) * sp for d in dims)
    gz, gy, gx = np.meshgrid(zs, ys, xs, indexing="ij")
    t_c = 10 + 0.01 * gx + 0.002 * gy + 0.001 * gz
    # 도구 좌표: X = 우리 X, Y = -우리 Y + 1000(cm 아님: mm로 바꿔 쓴다), 단위 mm, 온도 K
    px = gx * 10.0
    py = -gy * 10.0
    pz = gz * 10.0
    pts = np.stack([px.ravel(), py.ravel(), pz.ravel()], axis=1)
    # 비정렬 점 목록을 STRUCTURED_GRID로 쓴다(좌표가 임의라서 STRUCTURED_POINTS로는 못 쓴다)
    body = b"\n".join(b"%.6g %.6g %.6g" % tuple(p) for p in pts)
    raw = (b"# vtk DataFile Version 3.0\nx\nASCII\nDATASET STRUCTURED_GRID\nDIMENSIONS %d %d %d\nPOINTS %d float\n" % (*dims, len(pts))) + body + b"\n"
    raw += b"POINT_DATA %d\nSCALARS Temp float 1\nLOOKUP_TABLE default\n" % len(pts) + b"\n".join(b"%.6g" % v for v in (t_c.ravel() + 273.15)) + b"\n"
    vtk = tmp_path / "odd.vtk"
    vtk.write_bytes(raw)
    sensors, anchors, baseline = inputs()
    m = Mapping.from_dict({"unit": "mm", "axes": ["x", "-y", "z"], "field": "Temp", "temperature_unit": "K", "max_distance_cm": 15})
    rec, _ = build_case(vtk, m, sensors, anchors, baseline, "ext_odd", "odd", "")
    a = next(x for x in anchors["anchors"] if x["equipment"] == "rack_30" and x["metric"] == "temp_out")
    x, y, z = a["pos_cm"]
    sid = next(s["sensorId"] for s in sensors if s["equipment"] == "rack_30" and s["metric"] == "temp_out")
    assert abs(rec["values"][sid][0] - (10 + 0.01 * x + 0.002 * y + 0.001 * z)) < 0.15


def test_id_rule():
    with pytest.raises(PackError, match="ext_로 시작"):
        build_case("x.vtk", Mapping.from_dict({}), [], {"anchors": []}, {}, "normal", "t", "")


# ---- 저장소 보호 ----
def have_git():
    return shutil.which("git") is not None and (REPO / ".git").exists()


@pytest.mark.skipif(not have_git(), reason="git 저장소가 아님")
def test_output_must_be_a_git_ignored_location():
    ensure_ignored(REPO / "sim" / "out" / "local_only" / "external_pack")  # 기본 위치는 통과
    with pytest.raises(PackError, match="저장소에 올라갈 수 있다"):
        ensure_ignored(REPO / "docs" / "external_results")
    with pytest.raises(PackError, match="저장소에 올라갈 수 있다"):
        ensure_ignored(REPO / "web" / "viewer" / "public" / "data")


def test_output_outside_the_repo_is_allowed(tmp_path):
    ensure_ignored(tmp_path / "pack")


@pytest.mark.skipif(not have_git(), reason="git 저장소가 아님")
def test_no_external_result_files_are_tracked():
    files = subprocess.run(["git", "-C", str(REPO), "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines()
    bad = [f for f in files if re.search(r"\.(vtk|vtu|vti|room)$", f, re.I) or "external_pack" in f or "external_demo" in f]
    assert not bad, f"외부 도구의 결과로 보이는 파일이 저장소에 있다: {bad[:5]}"


@pytest.mark.skipif(not have_git(), reason="git 저장소가 아님")
def test_gitignore_blocks_vtk_and_room_files():
    for name in ("result.vtk", "a/b/field.vtu", "x.vti", "case.room", "sim/out/local_only/external_pack/index.json"):
        r = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", name], capture_output=True)
        assert r.returncode == 0, f"{name}이 gitignore에 없다"


# ---- 서버와 명령줄 ----
@needs_data
def test_pack_is_served_by_the_data_api_only_via_extra_dir(tmp_path):
    vtk = tmp_path / "lin.vtk"
    linear_field_vtk(vtk)
    sensors, anchors, baseline = inputs()
    rec, entry = build_case(vtk, Mapping.from_dict({}), sensors, anchors, baseline, "ext_lin", "선형 장", "시험")
    pack = write_pack(tmp_path / "pack", rec, entry)
    plain = DataApi(WEB_DATA, ORIGINS, {"solver": "l0"})
    withx = DataApi(WEB_DATA, ORIGINS, {"solver": "l0"}, extra_dirs=[pack])
    assert plain.route("GET", "/api/library/ext_lin", {}).status == 404  # 기본 자료만으로는 보이지 않는다
    r = withx.route("GET", "/api/library/ext_lin", {})
    assert r.status == 200 and json.loads(r.body)["meta"]["source"] == "external"
    lib = json.loads(withx.route("GET", "/api/library", {}).body)
    assert {g["id"] for g in lib["groups"]} == {"event", "supply", "load", "external"}
    assert [i["id"] for i in lib["index"]].count("ext_lin") == 1 and len(lib["index"]) == 13
    assert json.loads(withx.route("GET", "/api/meta", {}).body)["externalEntries"] == 1


@needs_data
def test_extra_dir_cannot_override_builtin_ids(tmp_path):
    (tmp_path / "rec").mkdir()
    (tmp_path / "index.json").write_text(json.dumps([{"id": "normal", "title": "가짜", "group": "external", "n": 3}]), encoding="utf-8")
    (tmp_path / "rec" / "normal.json").write_text(json.dumps({"version": 1, "n": 3, "scenario": "fake"}), encoding="utf-8")
    api = DataApi(WEB_DATA, ORIGINS, {"solver": "l0"}, extra_dirs=[tmp_path])
    assert json.loads(api.route("GET", "/api/library/normal", {}).body)["scenario"] == "normal"
    assert api.meta["externalEntries"] == 0


@needs_data
def test_write_pack_replaces_the_same_id(tmp_path):
    vtk = tmp_path / "lin.vtk"
    linear_field_vtk(vtk)
    sensors, anchors, baseline = inputs()
    rec, entry = build_case(vtk, Mapping.from_dict({}), sensors, anchors, baseline, "ext_lin", "첫째", "")
    write_pack(tmp_path / "pack", rec, entry)
    write_pack(tmp_path / "pack", rec, {**entry, "title": "둘째"})
    idx = json.loads((tmp_path / "pack" / "index.json").read_text(encoding="utf-8"))
    assert len(idx) == 1 and idx[0]["title"] == "둘째" and idx[0]["bytes"] > 0


@needs_data
def test_cli_inspect_build_and_clear_errors(tmp_path, capsys):
    vtk = tmp_path / "lin.vtk"
    linear_field_vtk(vtk)
    mp = tmp_path / "m.json"
    mp.write_text(json.dumps({"tool": "합성", "case": {"rack_power_kw": 7.5}}), encoding="utf-8")
    assert cli(["inspect", str(vtk)]) == 0
    assert "점 값 T" in capsys.readouterr().out
    out = tmp_path / "pack"
    assert cli(["build", "--vtk", str(vtk), "--mapping", str(mp), "--id", "ext_lin", "--title", "선형", "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "앵커 128개" in printed and "--extra-data-dir" in printed
    assert (out / "rec" / "ext_lin.json").exists()
    assert cli(["inspect", str(tmp_path / "없음.vtk")]) == 2
    mp.write_text("{", encoding="utf-8")
    assert cli(["build", "--vtk", str(vtk), "--mapping", str(mp), "--id", "ext_lin", "--title", "x", "--out", str(out)]) == 2
    assert "[오류]" in capsys.readouterr().err
