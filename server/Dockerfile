# DC-Twin 시뮬레이션 서버(CPU, L0 모델 + 미리 계산한 값 제공). 저장소 루트에서 빌드한다:
#   docker build -f server/Dockerfile -t dct-sim-server .
#   docker run --rm -p 127.0.0.1:8765:8765 -e DCT_TOKEN=<16자 이상 토큰> dct-sim-server
# 컨테이너 안에서는 0.0.0.0으로 열어야 해서(--allow-remote) 서버가 접근 토큰 없이는 시작하지 않는다(DCT_TOKEN). 토큰은 이미지에 넣지 않고 실행할 때 준다.
# GPU가 필요한 L1(Warp), L2(보정 모델)는 이 이미지에 없다. 이 컴퓨터에서 직접 실행한다(server/README.md).
# 확인: WSL의 Docker Engine 29.1.3에서 빌드, 실행, 헬스체크, 비루트(uid 10001), 읽기 전용, 접속(2026-11-04).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
RUN pip install numpy websockets && useradd --system --uid 10001 --no-create-home dct
WORKDIR /app

# 서버 코드와 데이터(센서 매니페스트, 미리 계산한 값의 목록과 녹화)만 넣는다. 나머지는 Dockerfile.dockerignore가 막는다.
COPY sim/sensors/dct_sensors /app/dct_sensors
COPY server/data/sensor_manifest.json /app/data/sensor_manifest.json
COPY web/viewer/public/data/index.json web/viewer/public/data/library.json /app/data/
COPY web/viewer/public/data/rec /app/data/rec

USER dct
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=2).status == 200 else 1)"

# 컨테이너 안에서는 0.0.0.0으로 열어야 밖에서 닿는다(--allow-remote). 밖으로 어디까지 열지는 실행할 때 -p로 정한다.
# 허용하는 웹 페이지 출처는 --origin으로 더한다(기본: 127.0.0.1, localhost, https://jangdave.github.io).
ENTRYPOINT ["python", "-m", "dct_sensors.serve", "--manifest", "/app/data/sensor_manifest.json", "--data-dir", "/app/data", "--host", "0.0.0.0", "--allow-remote", "--port", "8765"]
CMD ["--solver", "l0"]
