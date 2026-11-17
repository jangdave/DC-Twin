"""서버 홀 내부용 4K 텍스처(절차 생성)를 만든다. 시드를 고정해서 항상 같은 결과가 나오고, 모두 이어 붙여도 이음선이 없다.

실행 (저장소 루트에서):
    uv run --python 3.13 --with numpy --with pillow python blender/scripts/make_hall_textures.py
    uv run --python 3.13 --with numpy --with pillow python blender/scripts/make_hall_textures.py --only RackDoor   # 하나만

만드는 곳: blender/textures/hall/ (Git 제외). CC0 텍스처는 scripts/fetch_cc0_textures.py가 같은 폴더에 받는다.
모든 이미지는 4096 x 4096 픽셀이다. 실제 크기(cm)는 모델 스크립트의 UV 타일 크기와 같아야 한다.

| 이름 | 실제 크기 | 쓰는 곳 |
|---|---|---|
| T_RackDoor_*      | 60 x 60 cm          | 랙 앞문, 뒷문의 천공 철판 (구멍은 텍스처, 틀은 형상) |
| T_ServerFront_*   | 48.26 x 35.56 cm    | 서버 앞면. 가로는 19인치 폭, 세로는 8U. 1U 칸(512 px)마다 무늬가 다르다. 환기 구멍, 드라이브 칸, 표시등. 글자와 로고는 넣지 않는다 |
| T_HallHazard_*    | 40 x 40 cm          | 바닥 안전 표시(노랑-검정 45도 줄무늬). 줄 한 쌍이 10 cm |
| T_VentTile_*      | 50 x 100 cm         | 바닥 급기구 천공 타일 한 장(구멍 열린 면적 약 25 %). UV는 0~1 한 번 |
| T_CracPaint_*     | 100 x 100 cm        | CRAC 도장 철판의 아주 미세한 결(분전반 몸통, 홀 출입문도 같이 쓴다) |
| T_RppPanel_*      | 94 x 186 cm         | 분전반 앞판(차단기 창, 잠금 손잡이, 통풍 살). UV는 0~1 한 번 |
| T_EggCrate_*      | 60 x 60 cm          | 칸막이 천장 회수 그릴(알루미늄 격자, 칸 1.5 cm) |

- 노멀은 OpenGL 규약(Blender와 같다). 평균 기울기를 0.3 이하로 낮춰서 먼 거리에서 반짝이지 않게 한다. 결과를 출력한다.
- 형상으로 만든 것(랙 문틀, 케이블 바, 손잡이 등)은 텍스처에 다시 그리지 않는다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "blender" / "textures" / "hall"
N = 4096


def save_rgb(a: np.ndarray, name: str) -> None:
    Image.fromarray((np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8)).save(OUT / name)


def save_gray(a: np.ndarray, name: str) -> None:
    Image.fromarray((np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8), mode="L").convert("RGB").save(OUT / name)


def normal_from_height(h: np.ndarray, strength: float, name: str) -> float:
    """높이(0~1)에서 OpenGL 노멀 맵을 만든다. 평균 기울기(x, y 크기의 평균)를 돌려준다. 가장자리는 이어 붙는 방향(np.roll)으로 계산한다."""
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    gy_row = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5  # 행 방향(아래쪽)
    nx = -gx * strength
    ny = gy_row * strength  # 이미지 아래쪽이 -V라서 부호가 반대
    nz = np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / ln, ny / ln, nz / ln
    slope = float(np.mean(np.sqrt(nx * nx + ny * ny)))
    save_rgb(np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5], axis=-1), name)
    return slope


def periodic_noise(seed: int, cutoff: float) -> np.ndarray:
    """이어 붙는 저주파 노이즈(평균 0, 표준편차 1). cutoff는 통과시킬 최대 주파수(타일당 주기 수)."""
    rng = np.random.default_rng(seed)
    f = np.fft.rfft2(rng.standard_normal((N, N)).astype(np.float32))
    fy = np.fft.fftfreq(N)[:, None] * N
    fx = np.fft.rfftfreq(N)[None, :] * N
    mask = (np.hypot(fx, fy) <= cutoff).astype(np.float32)
    out = np.fft.irfft2(f * mask, s=(N, N)).astype(np.float32)
    return (out - out.mean()) / (out.std() + 1e-9)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def grid() -> tuple[np.ndarray, np.ndarray]:
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    return x + 0.5, y + 0.5  # 픽셀 중심


def blur(a: np.ndarray, r: int) -> np.ndarray:
    """이어 붙는 상자 흐림(여러 번 겹쳐 부드럽게)."""
    out = a
    for _ in range(2):
        for ax in (0, 1):
            acc = np.zeros_like(out)
            for s in range(-r, r + 1):
                acc += np.roll(out, s, axis=ax)
            out = acc / (2 * r + 1)
    return out


# --- 랙 문 (천공 철판) ----------------------------------------------------------
def make_rack_door() -> None:
    PITCH, DIA = 64.0, 54.0  # 60 cm에 구멍 64줄 -> 간격 0.94 cm, 구멍 지름 0.79 cm. 열린 면적 약 56 %
    x, y = grid()
    row = np.floor(y / PITCH)
    shift = np.where(row % 2 == 0, 0.0, PITCH / 2)
    dx = ((x + shift) % PITCH) - PITCH / 2
    dy = (y % PITCH) - PITCH / 2
    d = np.hypot(dx, dy) - DIA / 2  # 구멍 가장자리까지의 거리(바깥이 +)
    metal = smoothstep(-1.2, 1.2, d)  # 1이면 철판, 0이면 구멍
    rng_n = periodic_noise(11, 40)
    base = np.stack([np.full_like(x, 0.050), np.full_like(x, 0.052), np.full_like(x, 0.058)], axis=-1)
    base = base * (1.0 + 0.10 * rng_n[..., None] * 0.5)
    base = base * metal[..., None] + 0.008 * (1 - metal[..., None])
    save_rgb(base, "T_RackDoor_BaseColor.png")
    rough = 0.45 + 0.06 * rng_n
    rough = rough * metal + 0.9 * (1 - metal)
    save_gray(rough, "T_RackDoor_Roughness.png")
    height = blur(smoothstep(-5.0, 2.0, d), 2)  # 구멍 둘레의 작은 모서리
    slope = normal_from_height(height, 6.0, "T_RackDoor_Normal.png")
    print(f"T_RackDoor 완료. 열린 면적 {(1 - metal.mean()) * 100:.0f} %, 노멀 평균 기울기 {slope:.3f}")


# --- 서버 앞면 -----------------------------------------------------------------
def make_server_front() -> None:
    CELL_H = 512  # 1U 한 칸의 픽셀 높이 (8U = 4096)
    x, y = grid()
    W = float(N)
    cell = (y // CELL_H).astype(np.int32)
    cy = (y % CELL_H)  # 칸 안의 세로 위치
    fx = x / W  # 가로 0~1
    rngs = [np.random.default_rng(1000 + i) for i in range(8)]

    base = np.zeros((N, N, 3), dtype=np.float32)
    base[:] = (0.15, 0.16, 0.18)
    rough = np.full((N, N), 0.48, dtype=np.float32)
    height = np.zeros((N, N), dtype=np.float32)
    emis = np.zeros((N, N, 3), dtype=np.float32)

    n1 = periodic_noise(21, 30)
    base *= (1.0 + 0.04 * n1[..., None])
    rough += 0.04 * n1

    # 칸 위아래 가장자리: 1U 이음선(가는 어두운 줄)
    edge = np.minimum(cy, CELL_H - 1 - cy)
    seam = smoothstep(6.0, 1.5, edge)
    base *= (1 - 0.55 * seam[..., None])

    # 양쪽 귀(랙에 고정하는 판): 가로 0~0.045, 0.955~1
    ear = (fx < 0.045) | (fx > 0.955)
    base[ear] = (0.20, 0.21, 0.23)
    for ex in (0.0225 * W, W - 0.0225 * W):  # 나사 머리 자리(어두운 원)
        dscrew = np.hypot(x - ex, cy - CELL_H / 2)
        screw = smoothstep(26.0, 22.0, dscrew)
        base *= (1 - 0.6 * screw[..., None])
        height += 0.2 * screw

    # 환기 구멍 영역: 가로 0.34~0.80. 칸마다 구멍 크기를 다르게 한다(0~7번째 칸)
    vent_x0, vent_x1 = 0.34 * W, 0.80 * W
    in_vent = (x > vent_x0) & (x < vent_x1) & (cy > 60) & (cy < CELL_H - 60)
    pitch = np.zeros_like(x)
    dia = np.zeros_like(x)
    for r in range(8):
        sel = cell == r
        pitch[sel] = (20.0, 24.0, 20.0, 28.0, 24.0, 20.0, 32.0, 24.0)[r]
        dia[sel] = (13.0, 16.0, 14.0, 20.0, 16.0, 12.0, 22.0, 16.0)[r]
    row = np.floor(cy / pitch)
    shift = np.where(row % 2 == 0, 0.0, pitch / 2)
    ddx = ((x - vent_x0 + shift) % pitch) - pitch / 2
    ddy = (cy % pitch) - pitch / 2
    dh = np.hypot(ddx, ddy) - dia / 2
    hole = in_vent & (dh < 0)
    hole_soft = smoothstep(1.2, -1.2, dh) * in_vent
    base *= (1 - 0.92 * hole_soft[..., None])
    rough = rough * (1 - hole_soft) + 0.95 * hole_soft
    height += 0.5 * smoothstep(2.0, -4.0, dh) * in_vent

    # 드라이브 칸: 가로 0.06~0.30, 칸마다 개수 다름 (0이면 없음)
    bays = (4, 6, 8, 0, 4, 8, 0, 6)
    for r in range(8):
        nb = bays[r]
        if nb == 0:
            continue
        sel = cell == r
        bx0, bx1 = 0.06 * W, 0.30 * W
        bw = (bx1 - bx0) / nb
        idx = np.floor((x - bx0) / bw)
        lx = (x - bx0) - idx * bw
        inside = sel & (x > bx0) & (x < bx1) & (cy > 70) & (cy < CELL_H - 70) & (lx > 6) & (lx < bw - 6)
        base[inside] = (0.09, 0.095, 0.105)
        # 칸 가장자리 밝은 선(모서리 하이라이트)
        rim = inside & ((lx < 10) | (lx > bw - 10) | (cy < 78) | (cy > CELL_H - 78))
        base[rim] = (0.24, 0.25, 0.27)
        height[inside] += 0.3
        height[rim] -= 0.2
        # 손잡이 홈(가로 선)
        slot = inside & (np.abs(cy - CELL_H * 0.62) < 7) & (lx > 20) & (lx < bw - 20)
        base[slot] = (0.03, 0.03, 0.035)
        height[slot] -= 0.4

    # 오른쪽: 표시등 3개와 전원 단추. 색은 칸마다 정한다(초록, 파랑, 호박색). 표시등은 자체 발광 맵에 그린다.
    palette = [(0.1, 1.0, 0.25), (0.2, 0.55, 1.0), (1.0, 0.65, 0.1)]
    for r in range(8):
        rg = rngs[r]
        sel = cell == r
        for k in range(3):
            lx = (0.835 + 0.028 * k) * W
            col = palette[int(rg.integers(0, 3))] if k > 0 else palette[0]
            on = rg.random() > 0.15
            dd = np.hypot(x - lx, cy - CELL_H * 0.40)
            led = sel & (dd < 12)
            housing = sel & (dd < 17) & (dd >= 12)
            base[housing] = (0.02, 0.02, 0.022)
            if on:
                base[led] = np.array(col, dtype=np.float32) * 0.5
                emis[led] = np.array(col, dtype=np.float32)
            else:
                base[led] = (0.04, 0.04, 0.045)
        # 전원 단추(원형, 가는 테)
        pcx = 0.93 * W
        dp = np.hypot(x - pcx, cy - CELL_H * 0.5)
        ring = sel & (dp < 30) & (dp > 24)
        base[ring] = (0.30, 0.31, 0.33)
        btn = sel & (dp <= 24)
        base[btn] = (0.07, 0.07, 0.08)
        height[sel & (dp <= 24)] += 0.15
        # 오른쪽 아래 작은 포트 두 개
        for px in (0.86 * W, 0.89 * W):
            port = sel & (np.abs(x - px) < 22) & (np.abs(cy - CELL_H * 0.76) < 11)
            base[port] = (0.02, 0.02, 0.025)
            height[port] -= 0.3

    save_rgb(base, "T_ServerFront_BaseColor.png")
    save_gray(rough, "T_ServerFront_Roughness.png")
    save_rgb(emis, "T_ServerFront_Emissive.png")
    slope = normal_from_height(blur(height, 1), 1.8, "T_ServerFront_Normal.png")
    print(f"T_ServerFront 완료. 구멍 {hole.mean() * 100:.0f} %, 노멀 평균 기울기 {slope:.3f}")


# --- 바닥 안전 표시 ---------------------------------------------------------------
def make_hazard() -> None:
    x, y = grid()
    P = 1024.0  # 줄 한 쌍 = 10 cm (40 cm = 4096 px)
    t = ((x + y) % P) / P
    yellow = np.where(t >= 0.5, 1.0, 0.0).astype(np.float32)
    yellow = blur(yellow, 1)
    n = periodic_noise(31, 60)
    col_y = np.array([0.80, 0.60, 0.03], dtype=np.float32)
    col_k = np.array([0.025, 0.025, 0.028], dtype=np.float32)
    base = yellow[..., None] * col_y + (1 - yellow[..., None]) * col_k
    base *= (1.0 + 0.06 * n[..., None])
    save_rgb(base, "T_HallHazard_BaseColor.png")
    save_gray(0.55 + 0.06 * n, "T_HallHazard_Roughness.png")
    print("T_HallHazard 완료")


# --- 급기 천공 타일 ---------------------------------------------------------------
def make_vent_tile() -> None:
    x, y = grid()
    cmx = x / (N / 50.0)  # 가로 50 cm
    cmy = y / (N / 100.0)  # 세로 100 cm (이미지 위쪽이 v=1)
    pitch, dia, border = 3.0, 1.7, 2.5
    fx0, fy0 = border + 0.5, border + 0.5
    nx, ny = int((50 - 2 * border) // pitch), int((100 - 2 * border) // pitch)
    ox = (50 - nx * pitch) / 2
    oy = (100 - ny * pitch) / 2
    ix = np.floor((cmx - ox) / pitch)
    iy = np.floor((cmy - oy) / pitch)
    cx = ox + (ix + 0.5) * pitch
    cy = oy + (iy + 0.5) * pitch
    d = np.hypot(cmx - cx, cmy - cy) - dia / 2
    in_field = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    hole_soft = smoothstep(0.03, -0.03, d) * in_field  # 가장자리 흐림 0.03 cm
    n = periodic_noise(41, 50)
    base = np.stack([np.full_like(x, 0.16), np.full_like(x, 0.22), np.full_like(x, 0.30)], axis=-1)
    base *= (1 + 0.05 * n[..., None])
    # 테두리 안쪽 가는 홈선(타일 틀)
    edge = np.minimum(np.minimum(cmx, 50 - cmx), np.minimum(cmy, 100 - cmy))
    groove = smoothstep(0.12, 0.04, np.abs(edge - border + 0.2))
    base *= (1 - 0.35 * groove[..., None])
    base *= (1 - 0.94 * hole_soft[..., None])
    save_rgb(base, "T_VentTile_BaseColor.png")
    save_gray(np.clip((0.5 + 0.05 * n) * (1 - hole_soft) + 0.95 * hole_soft, 0, 1), "T_VentTile_Roughness.png")
    h = blur(smoothstep(0.1, -0.1, d) * in_field, 2) - 0.5 * groove
    slope = normal_from_height(h, 4.0, "T_VentTile_Normal.png")
    print(f"T_VentTile 완료. 열린 면적 {(hole_soft.mean()) * 100:.1f} %, 노멀 평균 기울기 {slope:.3f}")


# --- CRAC 도장 철판 -----------------------------------------------------------------
def make_crac_paint() -> None:
    n_lo = periodic_noise(51, 8)
    n_hi = periodic_noise(52, 600)
    base = np.stack([np.full((N, N), 0.62, np.float32), np.full((N, N), 0.64, np.float32), np.full((N, N), 0.66, np.float32)], axis=-1)
    base *= (1 + 0.006 * n_lo[..., None] + 0.006 * n_hi[..., None])  # 큰 얼룩을 줄임(2026-11-17, 공조기 큰 면이 얼룩져 보였다)
    save_rgb(base, "T_CracPaint_BaseColor.png")
    save_gray(0.46 + 0.03 * n_lo + 0.02 * n_hi, "T_CracPaint_Roughness.png")
    slope = normal_from_height(blur(n_hi * 0.5 + 0.5, 1), 0.5, "T_CracPaint_Normal.png")
    print(f"T_CracPaint 완료. 노멀 평균 기울기 {slope:.3f}")


# --- 분전반(RPP) 앞판 ---------------------------------------------------------------
RPP_W, RPP_H = 94.0, 186.0  # 앞판 실제 크기(cm). UV 0~1이 앞판 전체(hall_interior.build_power)


def make_rpp_panel() -> None:
    """분전반 앞판(docs/35): 바깥 문틀 홈, 잠금 손잡이, 가운데 차단기 창(2열 x 18단, 차단기마다 손잡이와 빈 이름표), 아래 통풍 살.
    글자와 로고는 넣지 않는다. 위쪽 표시창 자리(위에서 16~32 cm)는 비워 둔다(표시창은 형상)."""
    px, py = grid()
    x = px / N * RPP_W
    z = (1.0 - py / N) * RPP_H  # 아래가 0
    n = periodic_noise(61, 40)
    h = np.zeros((N, N), np.float32)
    col = np.stack([np.full((N, N), 0.20), np.full((N, N), 0.21), np.full((N, N), 0.23)], axis=-1).astype(np.float32)
    col *= (1 + 0.03 * n[..., None])
    rough = 0.45 + 0.03 * n
    # 문틀 홈(가장자리에서 2.5 cm 안쪽, 폭 0.3 cm)
    edge = np.minimum(np.minimum(x, RPP_W - x), np.minimum(z, RPP_H - z))
    groove = smoothstep(0.25, 0.05, np.abs(edge - 2.5))
    h -= 0.5 * groove
    col *= (1 - 0.5 * groove[..., None])
    # 차단기 창: 가로 12 ~ 82, 높이 55 ~ 140 cm(살짝 들어간 판)
    wx0, wx1, wz0, wz1 = 12.0, 82.0, 55.0, 140.0
    win = smoothstep(0.2, -0.2, np.maximum(np.maximum(wx0 - x, x - wx1), np.maximum(wz0 - z, z - wz1)))
    h -= 0.3 * win
    col = col * (1 - win[..., None]) + win[..., None] * np.array([0.11, 0.115, 0.125], np.float32)
    rows, pitch = 18, (wz1 - wz0 - 6.0) / 18
    for cx in (30.0, 64.0):  # 2열
        for k in range(rows):
            zc = wz0 + 3.0 + pitch * (k + 0.5)
            body = smoothstep(0.15, -0.15, np.maximum(np.abs(x - cx) - 13.0, np.abs(z - zc) - pitch * 0.38))
            tog = smoothstep(0.1, -0.1, np.maximum(np.abs(x - (cx - 4.0)) - 1.6, np.abs(z - zc) - pitch * 0.22))
            label = smoothstep(0.1, -0.1, np.maximum(np.abs(x - (cx + 6.0)) - 5.0, np.abs(z - zc) - pitch * 0.18))
            col = col * (1 - body[..., None]) + body[..., None] * np.array([0.06, 0.06, 0.065], np.float32)
            on = (k * 7 + int(cx)) % 5 != 0  # 대부분 켜짐(손잡이 밝음), 몇 개는 꺼짐
            tc = np.array([0.80, 0.80, 0.78] if on else [0.45, 0.45, 0.44], np.float32)
            col = col * (1 - tog[..., None]) + tog[..., None] * tc
            col = col * (1 - label[..., None]) + label[..., None] * np.array([0.72, 0.72, 0.66], np.float32)
            h += 0.35 * body + 0.4 * tog
            rough = rough * (1 - label) + 0.75 * label
    # 잠금 손잡이(오른쪽 가장자리, 높이 100 cm)
    hdl = smoothstep(0.15, -0.15, np.maximum(np.abs(x - (RPP_W - 7.0)) - 1.2, np.abs(z - 100.0) - 9.0))
    col = col * (1 - hdl[..., None]) + hdl[..., None] * np.array([0.55, 0.56, 0.58], np.float32)
    h += 0.8 * hdl
    rough = rough * (1 - hdl) + 0.25 * hdl
    # 아래 통풍 살(높이 8 ~ 40 cm, 살 간격 2.5 cm)
    lz = (z - 8.0) % 2.5
    louv = ((z > 8.0) & (z < 40.0) & (x > 12.0) & (x < RPP_W - 12.0)).astype(np.float32) * smoothstep(0.9, 1.2, lz) * smoothstep(2.4, 2.1, lz)
    col *= (1 - 0.85 * louv[..., None])
    h -= 0.6 * louv
    save_rgb(col, "T_RppPanel_BaseColor.png")
    save_gray(np.clip(rough, 0, 1), "T_RppPanel_Roughness.png")
    slope = normal_from_height(blur(h, 1), 3.0, "T_RppPanel_Normal.png")
    print(f"T_RppPanel 완료. 노멀 평균 기울기 {slope:.3f}")


# --- 천장 회수 그릴(에그크레이트) ----------------------------------------------------
GRILLE_TILE = 60.0  # 실제 크기(cm). hall_interior의 grille 재질 UV 타일과 같다


def make_egg_crate() -> None:
    """칸막이 천장 회수 그릴(docs/35): 알루미늄 격자(칸 1.5 cm, 벽 0.15 cm), 칸 안은 어둡다(위의 회수 공간). 이어 붙는다."""
    px, py = grid()
    c = GRILLE_TILE / N
    x, y = px * c, py * c
    pitch = GRILLE_TILE / 40  # 1.5 cm, 타일에 정수 개
    dx = np.abs((x % pitch) - pitch / 2)
    dy = np.abs((y % pitch) - pitch / 2)
    wall = np.maximum(smoothstep(pitch / 2 - 0.12, pitch / 2 - 0.06, dx), smoothstep(pitch / 2 - 0.12, pitch / 2 - 0.06, dy))
    n = periodic_noise(71, 30)
    alu = np.array([0.62, 0.64, 0.66], np.float32) * (1 + 0.03 * n[..., None])
    hole = np.array([0.03, 0.03, 0.035], np.float32)
    col = wall[..., None] * alu + (1 - wall[..., None]) * hole
    save_rgb(col, "T_EggCrate_BaseColor.png")
    save_gray(0.35 * wall + 0.9 * (1 - wall), "T_EggCrate_Roughness.png")
    slope = normal_from_height(blur(wall, 1), 4.0, "T_EggCrate_Normal.png")
    print(f"T_EggCrate 완료. 열린 면적 {(1 - wall).mean() * 100:.1f} %, 노멀 평균 기울기 {slope:.3f}")

JOBS = {
    "RackDoor": make_rack_door,
    "ServerFront": make_server_front,
    "Hazard": make_hazard,
    "VentTile": make_vent_tile,
    "CracPaint": make_crac_paint,
    "RppPanel": make_rpp_panel,
    "EggCrate": make_egg_crate,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="서버 홀 내부 4K 텍스처 만들기")
    ap.add_argument("--only", choices=sorted(JOBS), default=None)
    args = ap.parse_args(argv)
    if not sys.stdout.isatty() and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in JOBS.items():
        if args.only in (None, name):
            fn()
    return 0


if __name__ == "__main__":
    sys.exit(main())
