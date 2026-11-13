"""형상 사본 일치 검사(scripts/check_geometry.py, docs/30 M11): 지금 저장소는 맞고, 사본 하나를 틀리게 하면 잡는다."""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
import check_geometry as cg  # noqa: E402


def test_repo_copies_match_scene():
    assert cg.check() == []


def test_moved_rack_in_layout_is_caught(tmp_path, monkeypatch):
    lay = json.loads(cg.LAYOUT.read_text(encoding="utf-8"))
    lay["racks"][0]["min"][0] += 60.0  # 랙 하나를 옮겼는데 장면은 그대로
    p = tmp_path / "layout.json"
    p.write_text(json.dumps(lay), encoding="utf-8")
    monkeypatch.setattr(cg, "LAYOUT", p)
    probs = cg.check()
    assert any("layout.json" in x and "racks" in x for x in probs), probs


def test_web_scene_and_sensor_copies_are_checked(tmp_path, monkeypatch):
    web = tmp_path / "data"
    web.mkdir()
    for f in ("scene.json", "sensors.json"):
        shutil.copy(cg.WEB / f, web / f)
    scene = json.loads((web / "scene.json").read_text(encoding="utf-8"))
    scene["cracs"][0]["max"][1] += 10
    (web / "scene.json").write_text(json.dumps(scene), encoding="utf-8")
    sensors = json.loads((web / "sensors.json").read_text(encoding="utf-8"))
    sensors.pop()
    (web / "sensors.json").write_text(json.dumps(sensors), encoding="utf-8")
    monkeypatch.setattr(cg, "WEB", web)
    probs = cg.check()
    assert any("scene.json" in x and "cracs" in x for x in probs), probs
    assert any("sensors.json" in x for x in probs), probs
