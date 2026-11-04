// 게이트웨이의 핵심: 센서 값을 받아 검증하고, 알람을 판정하고, 이력과 집계를 만든다. (docs/11 4, 5, 9장)
// 네트워크(MQTT, WebSocket)와 분리해 두어서 Node 내장 시험으로 바로 검증할 수 있다.
//
// 시간: 센서 값의 시각(ts)을 시계로 쓴다(재생해도 같은 판정이 나오게). 그래서 시각이 이상한 샘플에 대한 규칙이 있다.
//  - 형식이 UTC ISO 8601(밀리초, Z)이 아니면 버린다.
//  - 지금까지 본 가장 늦은 시각보다 maxClockJumpMs 넘게 앞선 샘플은 버린다(미래로 튄 값 하나가 시계를 멈추는 것을 막음).
//  - 같은 센서의 직전 값보다 과거인 샘플은 버린다(순서가 뒤집힌 값). 단, 그 차이가 restartThresholdMs를 넘으면
//    생성기가 다시 시작된 것으로 보고 상태를 처음부터 다시 시작한다.
//  - 값이 하나도 안 오면(모든 센서가 동시에 끊김) 시계가 안 가므로, 실시간 입력에서는 heartbeat()를 주기적으로 불러 수신 시각만큼 시계를 민다.
import { EventEmitter } from 'node:events';
import { AlarmState, qualityFor } from './alarms.js';

export const DEFAULT_CONFIG = {
  historyMinutes: 15,        // 이력 보관(메모리)
  staleMs: 5000,             // 이 시간(센서 시각 기준) 동안 값이 없으면 stale
  hysteresis: 0.5,
  consecutive: 2,
  maxClockJumpMs: 3600000,   // 시계가 이만큼보다 크게 앞으로 점프하는 샘플은 버린다
  restartThresholdMs: 60000, // 같은 센서에서 이만큼보다 과거로 돌아가면 생성기 재시작으로 본다
  defaultIntervalMs: 1000,   // 첫 집계의 누적 전력량에 쓰는 간격
  // 집계 추정식(docs/11 9장). 합성 추정이며 실제 시설의 효율 계산이 아니다.
  // 파이썬 `dct_sensors/aggregates.py`, 웹 `web/viewer/src/sim/core.js`와 같은 식이며 공유 시험 자료(`sim/sensors/tests/aggregate_vectors.json`)로 함께 시험한다.
  fanPowerKw: 3.0,
  coolingBaseKw: 1.0,
  lossRatio: 0.06,
  tSupply: 18.0,            // 급기 온도(CRAC 공급 온도 센서가 없을 때만 쓴다. 있으면 센서에서 추정한다)
  tSupplyRef: 18.0,         // 냉각 효율의 기준 급기 온도
  coolingGainPerC: 0.03,    // 급기 온도 1도당 냉각 전력 변화율(가정, 실측 아님)
  itRefPerRackKw: 440 / 60, // 랙 1기당 기준 IT 전력. 기준 IT 전력 = 이 값 x 랙 수
  coolingLoadShare: 0.6,    // 냉각 전력 중 IT 부하에 비례하는 몫(가정, 실측 아님)
  cracSupplyRise: 6.0,      // CRAC 팬이 줄면 공급 온도가 오르는 정도(급기 온도 추정에 쓴다)
};

// 냉각 전력(kW). 급기 온도와 IT 부하의 영향은 가정이다.
export function coolingPower(cfg, { nCrac, nRacks, fanSum, it, tSupply = cfg.tSupply }) {
  const chiller = Math.min(Math.max(1 - cfg.coolingGainPerC * (tSupply - cfg.tSupplyRef), 0.6), 1.3);
  const load = 1 - cfg.coolingLoadShare + cfg.coolingLoadShare * (it / (cfg.itRefPerRackKw * nRacks));
  return (nCrac * cfg.coolingBaseKw + cfg.fanPowerKw * fanSum) * chiller * load;
}

const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const parseTs = (ts) => {
  if (typeof ts !== 'string' || !TS_RE.test(ts)) return null; // 시간대 없는 시각은 PC 시간대로 해석되어 어긋나므로 받지 않는다
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};
const iso = (ms) => new Date(ms).toISOString();

// 보정 모델(L2)이 붙이는 선택 필드: 90% 구간(lower, upper)과 신뢰 등급(confidence). 형식이 맞는 것만 통과시키고 값 자체의 판정에는 쓰지 않는다.
const CONFIDENCE = new Set(['ok', 'caution', 'low', 'fallback']);
function estimateFields(raw) {
  const out = {};
  if (Number.isFinite(raw.lower) && Number.isFinite(raw.upper) && raw.lower <= raw.upper) {
    out.lower = raw.lower;
    out.upper = raw.upper;
  }
  if (CONFIDENCE.has(raw.confidence)) out.confidence = raw.confidence;
  return out;
}

export class Gateway extends EventEmitter {
  constructor(manifest, config = {}) {
    super();
    this.manifest = manifest;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.byId = new Map(manifest.sensors.map((s) => [s.sensorId, s]));
    this.byTopic = new Map(manifest.sensors.map((s) => [s.topic, s]));
    this.dropped = { format: 0, unit: 0, unknown: 0, late: 0, jump: 0, stale: 0 };
    this.racks = manifest.sensors.filter((s) => s.equipmentType === 'rack' && s.metric === 'power');
    this.fans = manifest.sensors.filter((s) => s.metric === 'fan_speed');
    this.supplies = manifest.sensors.filter((s) => s.equipmentType === 'crac' && s.metric === 'supply_temp');
    this.fanByPath = new Map(this.fans.map((s) => [s.equipmentPath, s]));
    this.scenario = null;
    this.reset();
  }

  // 시간, 최근 값, 이력, 알람, 집계를 처음 상태로 되돌린다(시나리오가 시작될 때, 생성기가 다시 시작됐을 때).
  reset() {
    const m = this.manifest;
    this.latest = new Map();        // sensorId -> { value, unit, quality, ts, alarm }
    this.history = new Map(m.sensors.map((s) => [s.sensorId, []]));
    this.alarms = new Map(m.sensors.map((s) => [s.sensorId, new AlarmState({ ...s, direction: s.direction ?? 'high', hysteresis: this.cfg.hysteresis, consecutive: this.cfg.consecutive })]));
    this.lastSeenMs = new Map();    // sensorId -> 마지막 값의 시각(ms)
    this.clockMs = 0;               // stale 판정에 쓰는 시계(샘플 시각 또는 heartbeat로 민 시각)
    this.tickMs = 0;                // 지금까지 본 가장 늦은 샘플 시각(집계 단위)
    this.lastWallMs = null;
    this.aggregates = {};
    this.energyKwh = 0;
    this._lastAggMs = null;
    this._aggPending = false;
  }

  log(msg) {
    this.emit('log', msg);
  }

  // 센서 값 한 건을 넣는다. { sensorId | topic, ts, value, unit, quality? }
  ingest(raw) {
    if (!raw || typeof raw !== 'object') return this.#drop('format', raw);
    const sensor = this.byId.get(raw.sensorId) ?? this.byTopic.get(raw.topic);
    if (!sensor) return this.#drop('unknown', raw);
    const tsMs = parseTs(raw.ts);
    if (tsMs == null || typeof raw.value !== 'number' || !Number.isFinite(raw.value) || typeof raw.unit !== 'string') return this.#drop('format', raw);
    if (raw.unit !== sensor.unit) return this.#drop('unit', raw);
    if (raw.quality === 'stale') return this.#drop('stale', raw, false); // stale은 게이트웨이가 만드는 값이라(녹화에 남음) 다시 넣으면 정상 값으로 되돌아가므로 무시한다

    const id = sensor.sensorId;
    const seen = this.lastSeenMs.get(id);
    if (seen != null && tsMs < seen) {
      if (this.tickMs - tsMs > this.cfg.restartThresholdMs) {
        this.log(`센서 시각이 ${Math.round((this.tickMs - tsMs) / 1000)}초 과거로 돌아가 생성기가 다시 시작된 것으로 보고 상태를 초기화한다`);
        this.reset();
      } else {
        return this.#drop('late', raw);
      }
    }
    if (this.tickMs > 0 && tsMs - this.tickMs > this.cfg.maxClockJumpMs) return this.#drop('jump', raw);

    if (tsMs > this.tickMs) {
      this.#closeTick(); // 이전 시각의 샘플이 모두 들어왔으므로 그 시각의 집계를 확정한다
      this.tickMs = tsMs;
    }
    this.#advanceClock(tsMs);
    this.lastWallMs = Date.now();

    const quality = raw.quality === 'bad' ? 'bad' : qualityFor(raw.value, sensor.range ?? [-Infinity, Infinity]);
    const prev = this.latest.get(id);
    const entry = { sensorId: id, value: raw.value, unit: sensor.unit, quality, ts: iso(tsMs), alarm: prev?.alarm ?? 'normal', ...estimateFields(raw) };
    this.latest.set(id, entry);
    this.lastSeenMs.set(id, tsMs);

    const hist = this.history.get(id);
    hist.push({ ts: entry.ts, value: raw.value, quality });
    const cutoff = tsMs - this.cfg.historyMinutes * 60000;
    while (hist.length && parseTs(hist[0].ts) < cutoff) hist.shift();
    this._aggPending = true;

    this.emit('sample', { type: 'sample', sensorId: id, value: raw.value, unit: sensor.unit, quality, ts: entry.ts, ...estimateFields(raw) });
    const alarm = this.alarms.get(id);
    if (quality === 'good') {
      const tr = alarm.update(raw.value);
      if (tr) {
        entry.alarm = tr[1];
        this.emit('alarm', { type: 'alarm', sensorId: id, from: tr[0], to: tr[1], value: raw.value, ts: entry.ts });
      }
    } else {
      alarm.breakRun(); // 좋은 값이 아닌 샘플이 끼면 "2번 연속"이 끊긴다
    }
    return entry;
  }

  // MQTT 메시지(주소와 JSON 문자열 또는 객체)를 넣는다. 센서는 주소로만 정한다(페이로드의 sensorId는 무시).
  ingestMqtt(topic, payload) {
    let obj = payload;
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      try {
        obj = JSON.parse(payload.toString());
      } catch {
        return this.#drop('format', { topic, payload: String(payload).slice(0, 80) });
      }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return this.#drop('format', { topic });
    const { sensorId: _ignored, ...rest } = obj;
    return this.ingest({ ...rest, topic });
  }

  scenarioEvent(msg) {
    if (msg.event === 'start') {
      this.reset(); // 새 시나리오는 처음부터(재생을 반복하거나 생성기를 다시 돌려도 같은 결과가 나오게)
      this.scenario = msg.name;
      this.emit('scenario', { type: 'scenario', name: msg.name, event: 'start', ts: msg.ts });
    } else if (msg.event === 'end') {
      this.flush();
      this.scenario = null;
      this.emit('scenario', { type: 'scenario', name: msg.name, event: 'end', ts: msg.ts });
    }
  }

  // 마지막 시각의 집계를 확정한다(재생이 끝났을 때, 시나리오가 끝날 때).
  flush() {
    this.#closeTick();
  }

  // 실시간 입력에서 주기적으로 부른다. 값이 안 올 때도 수신 시각만큼 시계를 밀어서 stale을 판정한다.
  heartbeat(wallMs = Date.now()) {
    if (this.lastWallMs == null) return;
    this.#advanceClock(this.tickMs + (wallMs - this.lastWallMs));
  }

  #advanceClock(ms) {
    if (ms <= this.clockMs) return;
    this.clockMs = ms;
    for (const [id, seen] of this.lastSeenMs) {
      const e = this.latest.get(id);
      if (e && e.quality !== 'stale' && ms - seen > this.cfg.staleMs) {
        e.quality = 'stale';
        this.alarms.get(id).breakRun();
        this.emit('sample', { type: 'sample', sensorId: id, value: e.value, unit: e.unit, quality: 'stale', ts: iso(ms) });
      }
    }
  }

  // 한 시각(tickMs)의 샘플이 모두 들어온 뒤에 집계를 계산한다. (그 시각의 값으로 계산해야 생성기의 집계와 같다)
  #closeTick() {
    if (!this._aggPending || this.tickMs === 0) return;
    this._aggPending = false;
    const cfg = this.cfg;
    let it = 0;
    for (const s of this.racks) it += this.latest.get(s.sensorId)?.value ?? 0;
    let fanSum = 0;
    for (const s of this.fans) fanSum += (this.latest.get(s.sensorId)?.value ?? 100) / 100;
    const nCrac = new Set(this.fans.map((s) => s.equipmentPath)).size;
    // 급기 온도: 게이트웨이는 명령값을 모르므로 CRAC 공급 온도 센서에서 거꾸로 추정한다(공급 온도 = 급기 + 6 x (1 - 팬 비율)). 센서가 없으면 기본값.
    let tSupply = cfg.tSupply;
    let n = 0;
    let sum = 0;
    for (const s of this.supplies) {
      const v = this.latest.get(s.sensorId)?.value;
      if (!Number.isFinite(v)) continue;
      const fan = (this.latest.get(this.fanByPath.get(s.equipmentPath)?.sensorId)?.value ?? 100) / 100;
      sum += v - cfg.cracSupplyRise * (1 - fan);
      n++;
    }
    if (n) tSupply = sum / n;
    const cooling = coolingPower(cfg, { nCrac, nRacks: this.racks.length, fanSum, it, tSupply });
    const facility = it + cooling + it * cfg.lossRatio;
    const dtMs = this._lastAggMs == null ? cfg.defaultIntervalMs : this.tickMs - this._lastAggMs;
    this.energyKwh += (facility * dtMs) / 3600000;
    this._lastAggMs = this.tickMs;
    const next = {
      it_power: [it, 'kW'], cooling_power: [cooling, 'kW'], facility_power: [facility, 'kW'],
      pue: [it > 0 ? facility / it : 0, ''], energy_kwh: [this.energyKwh, 'kWh'],
    };
    for (const [name, [value, unit]] of Object.entries(next)) {
      const v = Math.round(value * 10000) / 10000;
      this.aggregates[name] = { name, value: v, unit, ts: iso(this.tickMs) };
      this.emit('aggregate', { type: 'aggregate', name, value: v, unit, ts: iso(this.tickMs) });
    }
  }

  #drop(kind, raw, log = true) {
    this.dropped[kind] += 1;
    if (log) this.log(`버린 메시지(${kind}): ${JSON.stringify(raw)?.slice(0, 120)}`);
    return null;
  }

  // 접속 직후 한 번 보내는 전체 상태 (docs/11 4.3장). 아직 값이 없는 센서도 자리를 채운다(value null, quality stale).
  snapshot() {
    const sensors = this.manifest.sensors.map((s) => this.latest.get(s.sensorId) ?? { sensorId: s.sensorId, value: null, unit: s.unit, quality: 'stale', ts: null, alarm: 'normal' });
    return {
      type: 'snapshot',
      ts: this.clockMs ? iso(this.clockMs) : null,
      scenario: this.scenario,
      sensors,
      aggregates: this.aggregates,
    };
  }

  // 센서의 마지막 값 시각을 기준으로 최근 minutes분의 이력을 돌려준다(전체 시계가 어긋나도 그 센서의 이력은 보인다).
  historyOf(sensorId, minutes = this.cfg.historyMinutes) {
    const hist = this.history.get(sensorId);
    if (!hist) return null;
    const last = this.lastSeenMs.get(sensorId);
    if (last == null) return [];
    const cutoff = last - minutes * 60000;
    return hist.filter((h) => parseTs(h.ts) >= cutoff);
  }
}
