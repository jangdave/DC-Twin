"""내보내는 방법. 같은 줄 형식을 파일(.jsonl), 표준 출력, MQTT로 보낼 수 있다."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import IO


class JsonlPublisher:
    """한 줄에 하나씩 JSON으로 쓴다(녹화 형식, 11 데이터 규격 5장). path가 None이면 표준 출력."""

    def __init__(self, path: str | Path | None = None):
        self._own = path is not None
        if path is not None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.f: IO[str] = open(path, "w", encoding="utf-8", newline="\n") if path is not None else sys.stdout

    def send(self, msg: dict) -> None:
        self.f.write(json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n")

    def close(self) -> None:
        if self._own:
            self.f.close()
        else:
            self.f.flush()


class MqttPublisher:
    """샘플을 MQTT 주소로 보낸다(QoS 0, retain 켬). 페이로드는 {ts, value, unit, quality}이고, 보정 모델(L2) 값이면 lower, upper, confidence가 더 붙는다(docs/11 표). 알람, 집계, 시나리오 줄은 보내지 않는다(게이트웨이가 만든다).

    paho-mqtt가 필요하다(`uv sync --extra mqtt`). 브로커(Mosquitto 등)는 이 저장소가 설치하지 않는다.
    """

    def __init__(self, host: str, port: int = 1883):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:  # noqa: BLE001
            raise SystemExit("paho-mqtt가 없다. `uv sync --extra mqtt`로 설치한다") from exc
        try:
            self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:  # 옛 버전
            self.c = mqtt.Client()
        self.c.connect(host, port, keepalive=30)
        self.c.loop_start()

    def send(self, msg: dict) -> None:
        if msg.get("type") != "sample":
            return
        payload = {k: msg[k] for k in ("ts", "value", "unit", "quality", "lower", "upper", "confidence") if k in msg}
        self.c.publish(msg["topic"], json.dumps(payload, separators=(",", ":")), qos=0, retain=True)

    def close(self) -> None:
        self.c.loop_stop()
        self.c.disconnect()


class Pacer:
    """시간 배율에 맞춰 기다린다. time_scale=0이면 기다리지 않는다(가능한 한 빠르게)."""

    def __init__(self, interval_s: float, time_scale: float):
        self.dt = interval_s / time_scale if time_scale > 0 else 0.0
        self.next = time.monotonic()

    def wait(self) -> None:
        if self.dt <= 0:
            return
        self.next += self.dt
        delay = self.next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
