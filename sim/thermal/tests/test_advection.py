"""hall60_sim.py의 이류 계산 시험: 선형 보간 방식과 MacCormack 방식의 수치 확산을 같은 조건에서 비교한다(GPU 없이 CPU로 돈다).

조건: 균일한 흐름 속의 가우스 모양 덩어리를 일정 거리 옮긴다. 정답은 모양이 그대로 이동하는 것이다.
확산을 0으로 두고 이류만 계산하므로, 모양이 퍼지거나 봉우리가 낮아지면 전부 수치 확산이다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import warp as wp

ROOT = Path(__file__).resolve().parents[3]  # 저장소
sys.path.insert(0, str(ROOT / "sim" / "thermal"))
from dct_thermal import hall60_sim as hs  # noqa: E402

DEVICE = "cpu"
NX, NY, NZ = 96, 6, 6
SIGMA_CELLS = 3.0


def run_advection(method: str, speed_ms: float, steps: int, shape=None):
    """x 방향으로 흐르는 균일한 흐름에서 이류만 계산한다. (처음 값, 마지막 값)을 numpy로 돌려준다."""
    nx, ny, nz = shape or (NX, NY, NZ)
    x = np.arange(nx, dtype=np.float32)
    profile = 18.0 + 10.0 * np.exp(-0.5 * ((x - 24.0) / SIGMA_CELLS) ** 2)
    T0 = np.broadcast_to(profile[:, None, None], (nx, ny, nz)).astype(np.float32).copy()
    T = wp.array(T0, dtype=float, device=DEVICE)
    T2 = wp.zeros((nx, ny, nz), dtype=float, device=DEVICE)
    T_hat = wp.zeros((nx, ny, nz), dtype=float, device=DEVICE)
    u = wp.array(np.broadcast_to(np.array([speed_ms, 0, 0], dtype=np.float32), (nx, ny, nz, 3)).copy(), dtype=wp.vec3, device=DEVICE)
    solid = wp.zeros((nx, ny, nz), dtype=int, device=DEVICE)
    rack_id = wp.array(np.full((nx, ny, nz), -1, dtype=np.int32), dtype=int, device=DEVICE)
    vent = wp.zeros((nx, ny, nz), dtype=int, device=DEVICE)
    heat = wp.zeros(1, dtype=float, device=DEVICE)
    dt = 0.04
    for _ in range(steps):
        if method == "maccormack":
            wp.launch(hs.advect_forward_kernel, dim=(nx, ny, nz), inputs=[T, T_hat, u, solid, rack_id, dt, hs.DX], device=DEVICE)
            wp.launch(hs.step_kernel_mc, dim=(nx, ny, nz), inputs=[T, T_hat, T2, u, solid, rack_id, vent, heat, dt, hs.DX, 0.0, 18.0, 0.0], device=DEVICE)
        else:
            wp.launch(hs.step_kernel, dim=(nx, ny, nz), inputs=[T, T2, u, solid, rack_id, vent, heat, dt, hs.DX, 0.0, 18.0, 0.0], device=DEVICE)
        T, T2 = T2, T
    return T0[:, 0, 0], T.numpy()[:, 0, 0]


def width_and_peak(profile: np.ndarray) -> tuple[float, float]:
    """18도를 뺀 덩어리의 표준편차(칸)와 봉우리 높이."""
    w = profile.astype(np.float64) - 18.0
    x = np.arange(len(w), dtype=np.float64)
    m = w.sum()
    mean = (w * x).sum() / m
    var = (w * (x - mean) ** 2).sum() / m
    return float(np.sqrt(var)), float(w.max())


# 1 m/s로 0.04초씩 40칸 가까이 옮기려면 격자 간격에 따라 다르다. 칸 수로 이동 거리를 맞춘다.
def _steps_for_cells(speed_ms: float, cells: float) -> int:
    return int(round(cells * hs.DX / (speed_ms * 0.04)))


@pytest.mark.parametrize("speed", [0.5, 1.0, 2.0])
def test_maccormack_spreads_less_than_linear(speed):
    steps = _steps_for_cells(speed, 40)
    _, lin = run_advection("linear", speed, steps)
    _, mc = run_advection("maccormack", speed, steps)
    w0, p0 = width_and_peak(run_advection("linear", speed, 0)[1])
    w_lin, p_lin = width_and_peak(lin)
    w_mc, p_mc = width_and_peak(mc)
    # 정보를 남긴다(pytest -s로 볼 수 있다)
    print(f"\n속도 {speed} m/s, 40칸 이동: 처음 폭 {w0:.2f} 봉우리 {p0:.2f} | 선형 폭 {w_lin:.2f} 봉우리 {p_lin:.2f} | MacCormack 폭 {w_mc:.2f} 봉우리 {p_mc:.2f}")
    assert w_lin > w0 * 1.3, "선형 방식은 눈에 띄게 퍼져야 한다(시험 조건 확인)"
    assert w_mc < w_lin, "MacCormack은 선형보다 덜 퍼져야 한다"
    assert p_mc > p_lin, "MacCormack은 봉우리가 더 많이 남아야 한다"
    assert w_mc < w0 * 1.25, "MacCormack은 처음 폭에 가까워야 한다"


@pytest.mark.parametrize("speed", [0.5, 2.0])
def test_maccormack_stays_in_range(speed):
    """값이 주변 값의 범위로 제한되므로 처음 최솟값 아래나 최댓값 위로 나가지 않는다(새 극값이 생기지 않는다)."""
    steps = _steps_for_cells(speed, 40)
    p0, mc = run_advection("maccormack", speed, steps)
    assert mc.min() >= p0.min() - 1e-4
    assert mc.max() <= p0.max() + 1e-4


def test_maccormack_moves_the_blob_at_the_right_speed():
    speed = 1.0
    steps = _steps_for_cells(speed, 40)
    p0, mc = run_advection("maccormack", speed, steps)
    c0 = ((p0 - 18.0) * np.arange(len(p0))).sum() / (p0 - 18.0).sum()
    c1 = ((mc - 18.0) * np.arange(len(mc))).sum() / (mc - 18.0).sum()
    assert c1 - c0 == pytest.approx(steps * speed * 0.04 / hs.DX, rel=0.03)


def test_unknown_method_is_rejected():
    class Dummy:
        pass

    with pytest.raises(ValueError):
        hs.Sim.__init__(Dummy(), {}, None, 1.0, 1.0, "cpu", "bad")
