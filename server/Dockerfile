# DC-Twin 시뮬레이션 서버(CPU, L0 모델 + 미리 계산한 값 제공). 저장소 루트에서 빌드한다:
#   docker build -f server/Dockerfile -t dct-sim-server .
#   docker run --rm -p 127.0.0.1:8765:8765 dct-sim-server
# GPU가 필요한 L1(Warp), L2(보정 모델)는 이 이미지에 없다. 이 컴퓨터에서 직접 실행한다(server/README.md).
# 주의: 이 이미지는 저장소를 만든 컴퓨터에 Docker가 없어 빌드와 실행을 시험하지 못했다.
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
