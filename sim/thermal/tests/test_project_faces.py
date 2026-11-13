"""받은 흐름의 투영(V4-2, docs/32): 투영한 면 속도의 발산이 우리 원천과 같아야 하고, 벽과 고체 면은 0이어야 한다."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]  # 저장소
sys.path.insert(0, str(ROOT / "sim" / "thermal"))
from dct_thermal import hall60_sim as hs  # noqa: E402

SCENE = ROOT / "usd" / "scenes" / "hall01.usda"
pytestmark = pytest.mark.skipif(not SCENE.exists(), reason="hall01.usda 없음")


def div_of(lay, faces):
    d = np.zeros(lay.shape)
    for a in range(3):
        hi = [slice(None)] * 3
        lo = [slice(None)] * 3
        hi[a] = slice(1, None)
        lo[a] = slice(0, -1)
        d += (faces[a][tuple(hi)] - faces[a][tuple(lo)]) / hs.DX
    return d


def test_projection_matches_sources_and_walls():
    hs.DX = 0.10
    hall = hs.read_hall(SCENE)
    lay = hs.Layout(hall)
    fan = np.ones(lay.n_cracs)
    fan[1] = 0.0
    s, _ = hs.source_field(lay, fan)
    rng = np.random.default_rng(1)
    u = rng.normal(0.0, 1.0, lay.shape + (3,))  # 아무렇게나 만든 흐름(발산이 원천과 전혀 맞지 않음)
    raw = hs.faces_from_cells(lay, u)
    faces, info = hs.project_faces(lay, s, raw)
    d = div_of(lay, faces)
    scale = float(np.abs(s[lay.fluid]).max())
    assert float(np.abs((d - s)[lay.fluid]).max()) < 1e-3 * scale
    for a in range(3):  # 고체와 닿은 면, 바깥 벽 면은 흐름이 없다
        lo = [slice(None)] * 3
        hi = [slice(None)] * 3
        lo[a] = slice(0, -1)
        hi[a] = slice(1, None)
        both = lay.fluid[tuple(lo)] & lay.fluid[tuple(hi)]
        mid = [slice(None)] * 3
        mid[a] = slice(1, -1)
        assert np.all(faces[a][tuple(mid)][~both] == 0.0)
        edge = [slice(None)] * 3
        edge[a] = 0
        assert np.all(faces[a][tuple(edge)] == 0.0)
    assert info["proj_residual"] < 1e-4
