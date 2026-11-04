"""서버에서 그리기 비용 측정: 홀 장면(usd/scenes/hall01.usda)을 ovrtx로 그려 프레임당 시간과 JPEG/WebP 크기를 잰다.

시각화 목적의 측정이다. 이 컴퓨터(RTX 5090) 한 대, 다른 작업이 GPU를 같이 쓸 수 있다.
사용 (이 폴더에서): uv run --python 3.13 python bench_ovrtx_frames.py
결과: out/bench_ovrtx_frames.json, out/bench_ovrtx_frame_*.jpg (미리보기)
"""
from __future__ import annotations

import io
import json
import os
import statistics
import time
from pathlib import Path

import numpy as np
import ovrtx
from PIL import Image
from pxr import Gf

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
HALL = (HERE.parent.parent / "usd" / "scenes" / "hall01.usda").resolve()
SIZES = [(640, 360), (1280, 720)]
WARMUP, N, REPEATS = 15, 60, 3


def look_at(eye, target) -> str:
    m = Gf.Matrix4d().SetLookAt(Gf.Vec3d(*eye), Gf.Vec3d(*target), Gf.Vec3d(0, 0, 1)).GetInverse()
    return "( " + ", ".join("(" + ", ".join(f"{m[r][c]:.6f}" for c in range(4)) + ")" for r in range(4)) + " )"


def build_usda() -> str:
    # 홀 크기 1100 x 1360 x 400 cm. 카메라는 입구 쪽 천장 근처에서 안쪽을 본다(가상 CCTV 시점 비슷).
    matrix = look_at((550.0, 80.0, 330.0), (550.0, 800.0, 60.0))
    prods = ""
    for w, h in SIZES:
        prods += f"""    def RenderProduct "P{w}" {{
        int2 resolution = ({w}, {h})
        rel camera = </DC/Cam>
        rel orderedVars = [</Render/LdrVar>]
    }}
"""
    return f"""#usda 1.0
(
    subLayers = [ @{HALL.as_posix()}@ ]
    metersPerUnit = 0.01
    upAxis = "Z"
)
over "DC" {{
    def DomeLight "Dome" {{
        float inputs:intensity = 3000
    }}
    def RectLight "Lamp" {{
        float inputs:intensity = 150000
        float inputs:width = 300
        float inputs:height = 300
        double3 xformOp:translate = (550, 680, 380)
        double3 xformOp:rotateXYZ = (180, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]
    }}
    def Camera "Cam" {{
        float focalLength = 16
        float horizontalAperture = 36
        matrix4d xformOp:transform = {matrix}
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }}
}}
def "Render" {{
    def RenderVar "LdrVar" {{
        string sourceName = "LdrColor"
    }}
{prods}}}
"""


def grab(products, name) -> np.ndarray:
    mapped = products[name].frames[0].render_vars["LdrColor"].map(device=ovrtx.Device.CPU)
    a = np.from_dlpack(mapped).copy()
    del mapped
    return a


def main() -> None:
    res: dict = {"hall": str(HALL), "warmup": WARMUP, "frames": N, "repeats": REPEATS, "note": "시각화 목적. 한 대의 PC, GPU 공유 가능"}
    t0 = time.perf_counter()
    r = ovrtx.Renderer()
    res["renderer_create_s"] = round(time.perf_counter() - t0, 2)
    t0 = time.perf_counter()
    r.open_usd_from_string(build_usda())
    res["open_usd_s"] = round(time.perf_counter() - t0, 2)
    res["sizes"] = {}
    for w, h in SIZES:
        prod = f"/Render/P{w}"
        t0 = time.perf_counter()
        for _ in range(WARMUP):
            r.step(render_products={prod}, delta_time=1 / 60)
        warm = time.perf_counter() - t0
        runs = []
        for rep in range(REPEATS):
            step_ms, map_ms, jpg_enc, webp_enc, jpg_b, webp_b = [], [], [], [], [], []
            for i in range(N):
                t = time.perf_counter()
                p = r.step(render_products={prod}, delta_time=1 / 60)
                t1 = time.perf_counter()
                a = grab(p, prod)
                t2 = time.perf_counter()
                step_ms.append((t1 - t) * 1000)
                map_ms.append((t2 - t1) * 1000)
                if i % 5 == 0:  # 인코딩은 5프레임마다 한 번 잰다
                    img = Image.fromarray(a[..., :3])
                    b = io.BytesIO(); t = time.perf_counter(); img.save(b, "JPEG", quality=75); jpg_enc.append((time.perf_counter() - t) * 1000); jpg_b.append(b.tell())
                    b = io.BytesIO(); t = time.perf_counter(); img.save(b, "WEBP", quality=75); webp_enc.append((time.perf_counter() - t) * 1000); webp_b.append(b.tell())
                    if rep == 0 and i == 0:
                        img.save(OUT / f"bench_ovrtx_frame_{w}.jpg", quality=85)
            runs.append({
                "step_ms_min": round(min(step_ms), 2), "step_ms_median": round(statistics.median(step_ms), 2), "step_ms_max": round(max(step_ms), 2),
                "map_copy_ms_median": round(statistics.median(map_ms), 2),
                "jpeg_q75_bytes_median": int(statistics.median(jpg_b)), "jpeg_encode_ms_median": round(statistics.median(jpg_enc), 2),
                "webp_q75_bytes_median": int(statistics.median(webp_b)), "webp_encode_ms_median": round(statistics.median(webp_enc), 2),
            })
        res["sizes"][f"{w}x{h}"] = {"warmup_s": round(warm, 2), "runs": runs}
        print(w, h, json.dumps(runs, ensure_ascii=False), flush=True)
    (OUT / "bench_ovrtx_frames.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    os._exit(0)  # 종료 시 멈추는 현상 회피(probe_ovrtx_outputs.py와 같음)


if __name__ == "__main__":
    main()
