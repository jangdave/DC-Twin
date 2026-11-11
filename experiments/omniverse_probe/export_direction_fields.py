"""온도의 '방향성' 표시 가능성 검토: 우리 Warp 열 모델에서 방향 정보를 실제로 뽑아 본다.

뽑는 것
  1) 공기 흐름(속도) 벡터장 u(x,y,z): CRAC 고장 전(30초)과 후(240초). 공기가 열을 실어 나르는 방향
  2) 도달 시간: 각 칸이 처음 주의 온도(27도) 이상이 된 시각. 열이 '어디서부터 어떤 순서로 번졌는가'
  3) 온도 기울기 -grad(T): 온도가 높은 쪽에서 낮은 쪽으로 향하는 방향(열이 이동하려는 방향)
  4) 화살표 표본: 정규 격자(40cm 간격)에서 위치, 방향, 속력, 온도 (UE 화살표 인스턴스용)

주의: 이 모델의 공기 흐름은 영역별로 정해 둔 값이다(thermal_poc.py). 계산해서 나온 물리적 흐름이 아니다.
사용 (이 폴더에서): uv run --python 3.13 python export_direction_fields.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import warp as wp

import thermal_poc as tp

OUT = Path(__file__).resolve().parent / "out" / "direction"
OUT.mkdir(parents=True, exist_ok=True)
DX = 0.1
T_WARN_C = 27.0
ARROW_STEP = 4  # 40cm 간격


@wp.kernel
def velocity_kernel(
    region: wp.array3d(dtype=int),
    aux_dir: wp.array3d(dtype=float),
    aux_idx: wp.array3d(dtype=int),
    fan: wp.array(dtype=float),
    v_rack: float,
    v_aisle: float,
    v_up: float,
    v_ceil: float,
    v_descend: float,
    u_out: wp.array3d(dtype=wp.vec3),
):
    """step_kernel의 '정해 둔 공기 흐름' 규칙과 같다. 속도를 저장하려고 따로 만든 커널이다."""
    i, j, k = wp.tid()
    ny = region.shape[1]
    r = region[i, j, k]
    u = wp.vec3(0.0, 0.0, 0.0)
    if r == 1:
        u = wp.vec3(0.0, -v_rack, 0.0)
    elif r == 2:
        u = wp.vec3(0.0, v_rack, 0.0)
    elif r == 3:
        f = fan[aux_idx[i, j, k]]
        u = wp.vec3(aux_dir[i, j, k] * v_aisle * f, 0.0, -v_descend)
    elif r == 4:
        u = wp.vec3(0.0, 0.0, v_up)
    elif r == 5:
        u = wp.vec3(aux_dir[i, j, k] * v_ceil, 0.0, 0.0)
        yc = 0.5 * float(ny - 1)
        if float(j) > yc:
            u = wp.vec3(u[0], -v_ceil * 0.5, 0.0)
        else:
            u = wp.vec3(u[0], v_ceil * 0.5, 0.0)
    u_out[i, j, k] = u


def velocity(hall: tp.Hall) -> np.ndarray:
    u = wp.zeros((hall.nx, hall.ny, hall.nz), dtype=wp.vec3, device=hall.device)
    wp.launch(
        velocity_kernel, dim=(hall.nx, hall.ny, hall.nz),
        inputs=[hall.region, hall.aux_dir, hall.aux_idx, hall.fan, tp.V_RACK, tp.V_AISLE, tp.V_UP, tp.V_CEIL, tp.V_DESCEND, u],
        device=hall.device,
    )
    return u.numpy().astype(np.float32)  # (nx, ny, nz, 3), m/s


def main() -> None:
    wp.config.quiet = True
    wp.init()
    tp.DX = DX
    tp.DT = min(0.02, 0.08 * DX**2 / tp.K_DIFF)
    hall = tp.Hall(tp.read_scene(tp.OUT / "poc_hall.usda"))
    steps_per_s = int(round(1.0 / tp.DT))
    hall.set_power(np.full(len(hall.scene["racks"]), 6.0, dtype=np.float32))

    arrival = np.full((hall.nx, hall.ny, hall.nz), -1.0, dtype=np.float32)  # 처음 27도 이상이 된 시각(초), 한 번도 안 되면 -1
    delta_arrival = np.full_like(arrival, -1.0)  # 고장 직전(60초) 대비 +3도 이상이 된 시각(고장 이후만)
    T60 = None
    u_before = u_after = T_final = None
    for s in range(1, 241):
        if s == 61:
            hall.set_fan(1, 0.0)  # 60초 지난 뒤 CRAC_02 팬 정지
        for _ in range(steps_per_s):
            hall.step()
        T = hall.T.numpy()
        newly = (arrival < 0) & (T >= T_WARN_C)
        arrival[newly] = float(s)
        if s == 60:
            T60 = T.copy()
        if s > 60 and T60 is not None:
            hit = (delta_arrival < 0) & ((T - T60) >= 3.0)
            delta_arrival[hit] = float(s - 60)  # 고장 후 경과 시간(초)
        if s == 30:
            u_before = velocity(hall)
        if s == 240:
            u_after = velocity(hall)
            T_final = T.astype(np.float32)

    # 온도 기울기 -grad(T): 열이 높은 쪽에서 낮은 쪽으로 이동하려는 방향. np.gradient는 (x, y, z) 순서로 돌려준다.
    gx, gy, gz = np.gradient(T_final, DX)
    heat_dir = -np.stack([gx, gy, gz], axis=-1)  # K/m

    np.save(OUT / "u_t030.npy", u_before)
    np.save(OUT / "u_t240.npy", u_after)
    np.save(OUT / "arrival_27C.npy", arrival)
    np.save(OUT / "arrival_delta3C_after_failure.npy", delta_arrival)
    np.save(OUT / "T_t240.npy", T_final)
    np.save(OUT / "heat_dir_t240.npy", heat_dir.astype(np.float32))

    # 화살표 표본: 정규 격자에서 속력이 있는 곳만. 방향은 단위 벡터, 속력은 m/s, 온도는 섭씨
    racks_mask = (hall.rack_id.numpy() >= 0)
    arrows = []
    for i in range(ARROW_STEP // 2, hall.nx, ARROW_STEP):
        for j in range(ARROW_STEP // 2, hall.ny, ARROW_STEP):
            for k in range(ARROW_STEP // 2, hall.nz, ARROW_STEP):
                v = u_after[i, j, k]
                sp = float(np.linalg.norm(v))
                if sp < 0.05:
                    continue
                d = v / sp
                arrows.append({
                    "pos_cm": [round((i + 0.5) * DX * 100, 1), round((j + 0.5) * DX * 100, 1), round((k + 0.5) * DX * 100, 1)],
                    "dir": [round(float(d[0]), 3), round(float(d[1]), 3), round(float(d[2]), 3)],
                    "speed_ms": round(sp, 3),
                    "temp_c": round(float(T_final[i, j, k]), 2),
                    "in_rack": bool(racks_mask[i, j, k]),
                })
    (OUT / "arrows_t240.json").write_text(json.dumps({"step_cm": ARROW_STEP * DX * 100, "count": len(arrows), "arrows": arrows}, ensure_ascii=False), encoding="utf-8")

    # 통계와 점검
    def zone(name, sl):
        """영역 대표 방향: 평균 속도 벡터"""
        a, b = u_before[sl].reshape(-1, 3).mean(axis=0), u_after[sl].reshape(-1, 3).mean(axis=0)
        return {"zone": name, "mean_u_before": [round(float(x), 3) for x in a], "mean_u_after": [round(float(x), 3) for x in b]}

    cold_east = (slice(55, 75), slice(25, 35), slice(2, 18))   # 냉기 통로 동쪽(고장난 CRAC_02 쪽), x 5.5~7.5m
    cold_west = (slice(5, 25), slice(25, 35), slice(2, 18))    # 냉기 통로 서쪽(정상 CRAC_01 쪽)
    hot_aisle = (slice(30, 55), slice(5, 13), slice(2, 20))    # 열기 통로
    reached = arrival >= 0
    east_cells = reached[hall.nx // 2:]
    west_cells = reached[: hall.nx // 2]
    stats = {
        "grid": [hall.nx, hall.ny, hall.nz],
        "velocity_ms": {"max_before": round(float(np.linalg.norm(u_before, axis=-1).max()), 3), "max_after": round(float(np.linalg.norm(u_after, axis=-1).max()), 3)},
        "zones": [zone("냉기 통로 동쪽(고장 CRAC_02 쪽)", cold_east), zone("냉기 통로 서쪽(정상 CRAC_01 쪽)", cold_west), zone("열기 통로", hot_aisle)],
        "arrival_27C": {
            "cells_reached_percent_total": round(float(reached.mean() * 100), 1),
            "cells_reached_percent_east_half": round(float(east_cells.mean() * 100), 1),
            "cells_reached_percent_west_half": round(float(west_cells.mean() * 100), 1),
            "earliest_s": float(arrival[reached].min()) if reached.any() else None,
            "median_s": float(np.median(arrival[reached])) if reached.any() else None,
            "latest_s": float(arrival[reached].max()) if reached.any() else None,
        },
        "arrival_plus3C_after_failure": (lambda d: {
            "cells_reached_percent_east_half": round(float((d[hall.nx // 2:] >= 0).mean() * 100), 1),
            "cells_reached_percent_west_half": round(float((d[: hall.nx // 2] >= 0).mean() * 100), 1),
            "median_s_east_half": float(np.median(d[hall.nx // 2:][d[hall.nx // 2:] >= 0])) if (d[hall.nx // 2:] >= 0).any() else None,
            "median_s_west_half": float(np.median(d[: hall.nx // 2][d[: hall.nx // 2] >= 0])) if (d[: hall.nx // 2] >= 0).any() else None,
            "x_of_median_arrival_by_time_s": {str(s): round(float(np.mean(np.where(d == s)[0]) * DX), 2) for s in (5, 20, 60, 120) if (d == s).any()},
        })(delta_arrival),
        "heat_direction_K_per_m": {"max_magnitude": round(float(np.linalg.norm(heat_dir, axis=-1).max()), 2), "median_magnitude": round(float(np.median(np.linalg.norm(heat_dir, axis=-1))), 3)},
        "arrows": {"count": len(arrows), "step_cm": ARROW_STEP * DX * 100, "in_rack": sum(1 for a in arrows if a["in_rack"])},
    }
    (OUT / "direction_stats.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(stats, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
