"""작업 흐름을 웹 형식으로 바꾸기(web_flow.py) 시험."""
import base64

import numpy as np
import pytest

from dct_sensors import web_flow


def test_downsample_skips_blocked_cells():
    u = np.zeros((2, 2, 2, 3))
    u[0, 0, 0] = [2.0, 0, 0]
    present = np.zeros((2, 2, 2), bool)
    present[0, 0, 0] = True
    d = web_flow.downsample(u, present)
    assert d.shape == (1, 1, 1, 3) and d[0, 0, 0, 0] == pytest.approx(2.0)  # 막힌 칸의 0은 평균에 넣지 않는다


def test_encode_keeps_fields_in_order_and_scale():
    present = np.ones((4, 4, 4), bool)
    a = np.zeros((4, 4, 4, 3))
    a[..., 0] = 1.0
    b = np.zeros((4, 4, 4, 3))
    b[..., 2] = -20.0  # 눈금 밖은 잘린다
    out = web_flow.encode([{"U": a, "fan": {"crac_01": 1.0}, "from_s": 0, "iterations": 10, "converged": True},
                           {"U": b, "fan": {"crac_01": 0.0}, "from_s": 60}], present, dx_m=0.1, z0_m=-0.8, plenum={"depth_cm": 60})
    assert out["encoding"] == "sequence" and out["shape"] == [2, 2, 2] and out["cell_m"] == pytest.approx(0.2) and out["z0_m"] == -0.8
    assert [f["from_s"] for f in out["fields"]] == [0, 60] and out["fields"][1]["fan"] == {"crac_01": 0.0}
    raw = np.frombuffer(base64.b64decode(out["data_b64"]), np.int8).reshape(2, 2, 2, 2, 3)
    assert raw[0, ..., 0].min() == round(1.0 / web_flow.VMAX * 127) and raw[1, ..., 2].max() == -127


def test_encode_refuses_empty_or_mismatched():
    present = np.ones((4, 4, 4), bool)
    with pytest.raises(ValueError):
        web_flow.encode([], present, 0.1)
    with pytest.raises(ValueError):
        web_flow.encode([{"U": np.zeros((4, 4, 4, 3)), "fan": {}}, {"U": np.zeros((4, 4, 2, 3)), "fan": {}}], present, 0.1)
