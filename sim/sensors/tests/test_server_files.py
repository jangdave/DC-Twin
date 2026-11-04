"""server/ 폴더의 실행 구성이 저장소와 맞는지 코드로 확인한다(Docker가 없는 컴퓨터에서도 돌게).
Dockerfile을 실제로 빌드하고 실행하는 시험이 아니다. 경로, 명령, 사본이 어긋났는지만 본다."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from dct_sensors.manifest import load_manifest

REPO = Path(__file__).resolve().parents[3]
SERVER = REPO / "server"


def test_committed_manifest_loads_and_matches_the_expected_hall():
    m = load_manifest(SERVER / "data" / "sensor_manifest.json")
    assert len(m.rack_names) == 60 and len(m.cracs) == 8 and len(m.sensors) == 204


def test_committed_manifest_equals_the_generated_one_when_available():
    src = REPO / "sim" / "out" / "sensor_manifest.json"
    if not src.exists():
        pytest.skip("원본 매니페스트(sim/out, gitignore)가 이 컴퓨터에 없다")
    assert json.loads(src.read_text(encoding="utf-8")) == json.loads((SERVER / "data" / "sensor_manifest.json").read_text(encoding="utf-8"))


def dockerfile_lines():
    return [ln.strip() for ln in (SERVER / "Dockerfile").read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.strip().startswith("#")]


def test_dockerfile_copies_only_existing_paths():
    copies = [ln for ln in dockerfile_lines() if ln.startswith("COPY ")]
    assert copies
    for ln in copies:
        *srcs, dst = ln.split()[1:]
        assert dst.startswith("/app"), ln
        for s in srcs:
            assert (REPO / s).exists(), f"Dockerfile이 없는 경로를 복사한다: {s}"


def test_dockerfile_entrypoint_runs_the_serve_module_with_data_and_a_remote_flag():
    text = "\n".join(dockerfile_lines())
    m = re.search(r"ENTRYPOINT \[(.*)\]", text)
    assert m
    argv = json.loads(f"[{m.group(1)}]")
    assert argv[:3] == ["python", "-m", "dct_sensors.serve"]
    # 컨테이너 안에서 0.0.0.0으로 열려면 --allow-remote가 있어야 서버가 시작한다(serve.py의 안전 장치)
    assert "--allow-remote" in argv and "--host" in argv and argv[argv.index("--host") + 1] == "0.0.0.0"
    assert "--data-dir" in argv and "--manifest" in argv
    assert (REPO / "sim" / "sensors" / "dct_sensors" / "serve.py").exists()
    # 기본 모델은 CPU로 되는 l0여야 한다(이 이미지에는 GPU 모델이 없다)
    assert re.search(r'CMD \["--solver", "l0"\]', text)


def test_dockerfile_runs_as_non_root_and_has_a_healthcheck():
    text = "\n".join(dockerfile_lines())
    assert re.search(r"^USER dct$", text, re.M) and "HEALTHCHECK" in text and "/healthz" in text


def test_dockerignore_allows_exactly_what_the_dockerfile_copies():
    rules = [ln.strip() for ln in (SERVER / "Dockerfile.dockerignore").read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")]
    assert rules[0] == "*"  # 기본은 모두 막는다
    allowed = {r[1:] for r in rules if r.startswith("!")}
    for ln in (x for x in dockerfile_lines() if x.startswith("COPY ")):
        for s in ln.split()[1:-1]:
            assert s in allowed, f"Dockerfile.dockerignore가 {s}를 허용하지 않는다"


def test_compose_binds_to_loopback_only_by_default_and_requires_a_token():
    text = (SERVER / "docker-compose.yml").read_text(encoding="utf-8")
    assert '"127.0.0.1:8765:8765"' in text
    assert "dockerfile: server/Dockerfile" in text
    assert "DCT_TOKEN: ${DCT_TOKEN:?" in text  # 토큰이 없으면 compose가 시작 전에 거절한다(컨테이너는 0.0.0.0으로 열어 토큰이 필수)
    assert "read_only: true" in text and "cap_drop: [ALL]" in text and "no-new-privileges" in text


def test_dockerfile_never_bakes_a_token_into_the_image():
    text = (SERVER / "Dockerfile").read_text(encoding="utf-8")
    code = [ln for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    assert not any(ln.startswith(("ENV DCT_TOKEN", "ARG DCT_TOKEN")) or "--token" in ln for ln in code)


def test_secrets_files_are_ignored_by_git():
    import shutil
    import subprocess

    if shutil.which("git") is None or not (REPO / ".git").exists():
        pytest.skip("git 저장소가 아님")
    for name in ("server/.env", ".env", "prod.env"):
        assert subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", name], capture_output=True).returncode == 0, name


def test_run_local_script_uses_existing_paths():
    text = (SERVER / "run_local.ps1").read_text(encoding="utf-8")
    assert "server\\data\\sensor_manifest.json" in text and (SERVER / "data" / "sensor_manifest.json").exists()
    for rel in ("sim/sensors", "experiments/omniverse_probe", "web/viewer/public/data"):
        assert (REPO / rel).exists(), rel
    assert "dct_sensors.serve" in text


def test_library_files_the_image_would_serve_are_complete():
    data = REPO / "web" / "viewer" / "public" / "data"
    index = json.loads((data / "index.json").read_text(encoding="utf-8"))
    assert (data / "library.json").exists()
    for it in index:
        assert (data / "rec" / f"{it.get('file') or it['id']}.json").exists(), it["id"]


def test_serve_module_imports_outside_the_repo_like_in_the_container():
    """컨테이너에서는 /app/dct_sensors/serve.py라서 저장소 루트를 찾을 수 없다. 그래도 가져오고 시작할 수 있어야 한다(Docker 첫 실행에서 실제로 났던 오류)."""
    from dct_sensors.serve import repo_root_of

    assert repo_root_of(Path("/app/dct_sensors/serve.py")) is None
    assert repo_root_of(Path("C:/x/dct_sensors/serve.py")) is None
    assert repo_root_of(REPO / "sim" / "sensors" / "dct_sensors" / "serve.py") == REPO
