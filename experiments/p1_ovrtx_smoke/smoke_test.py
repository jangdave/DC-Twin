"""Phase 1 동작 확인 테스트: ovrtx로 로컬 USD를 렌더해 PNG로 저장하고 시간/VRAM을 기록한다.

사용: uv run python smoke_test.py [--frames N]
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import time
from pathlib import Path

from ovrtx import Device, Renderer
from PIL import Image

HERE = Path(__file__).resolve().parent
SCENE = HERE / "smoke_scene.usda"
OUT_DIR = HERE / "out"
PRODUCT = "/Render/Camera"


def vram_used_mib() -> int | None:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True
        )
        return int(out.strip().splitlines()[0])
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=30, help="렌더 프레임 수(워밍업 포함)")
    args = ap.parse_args()
    OUT_DIR.mkdir(exist_ok=True)

    result: dict = {"python": platform.python_version(), "scene": SCENE.name}
    vram0 = vram_used_mib()

    t0 = time.perf_counter()
    renderer = Renderer()
    result["renderer_create_s"] = round(time.perf_counter() - t0, 2)

    t0 = time.perf_counter()
    renderer.open_usd(str(SCENE))
    result["open_usd_s"] = round(time.perf_counter() - t0, 2)

    frame_times: list[float] = []
    last_pixels = None
    for i in range(args.frames):
        t0 = time.perf_counter()
        products = renderer.step(render_products={PRODUCT}, delta_time=1.0 / 60.0)
        for product in products.values():
            for frame in product.frames:
                with frame.render_vars["LdrColor"].map(device=Device.CPU) as var:
                    last_pixels = var.tensor.numpy().copy()
        frame_times.append(time.perf_counter() - t0)

    if last_pixels is None:
        raise RuntimeError("렌더 결과가 비어 있다")

    png = OUT_DIR / "smoke_render.png"
    Image.fromarray(last_pixels).save(png)

    first, rest = frame_times[0], frame_times[1:] or frame_times
    result.update(
        {
            "frames": args.frames,
            "first_frame_s": round(first, 3),
            "steady_frame_ms_median": round(sorted(rest)[len(rest) // 2] * 1000, 1),
            "image_shape": list(last_pixels.shape),
            "image_mean_rgb": [round(float(x), 1) for x in last_pixels[..., :3].reshape(-1, 3).mean(axis=0)],
            "vram_before_mib": vram0,
            "vram_after_mib": vram_used_mib(),
            "output": str(png.relative_to(HERE)),
        }
    )
    (OUT_DIR / "smoke_result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
