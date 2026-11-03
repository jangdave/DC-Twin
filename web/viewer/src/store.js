// 센서 값 저장소 (docs/18 5.2장). 녹화 재생과 라이브가 같은 저장소를 갱신하고, 화면은 이 저장소만 읽는다.
import { ALARM_RANK } from './colors.js';

export const HISTORY_LENGTH = 120; // 최근 2분(초 단위 값 기준)

export class SensorStore {
  constructor(sensors) {
    this.sensors = sensors; // 센서 정보 배열(sensors.json)
    this.byId = new Map(sensors.map((s) => [s.sensorId, s]));
    this.byEquipment = new Map(); // 장비 이름(rack_01) -> { temp_in: sensorId, ... }
    for (const s of sensors) {
      if (!this.byEquipment.has(s.equipment)) this.byEquipment.set(s.equipment, {});
      this.byEquipment.get(s.equipment)[s.metric] = s.sensorId;
    }
    this.version = 0; // 값이 바뀔 때마다 늘어난다(화면이 다시 그릴 때를 안다)
    this.ignored = 0; // 모르는 센서의 메시지 수
    this.clear();
  }

  clear() {
    this.latest = new Map(); // sensorId -> { value, quality, lower, upper, confidence, alarm, ts }
    this.history = new Map(); // sensorId -> [{ value, lower, upper }]
    this.aggregates = {};
    this.alarmLog = []; // { t 또는 ts, sensorId, from, to, value }
    this.events = []; // 서버가 알려 준 조작 { t, kind, target, value }
    this.controls = null; // 서버가 snapshot으로 알려 준 조작 상태 { fan, powerScale }
    this.scenario = null;
    this.version++;
  }

  has(id) {
    return this.byId.has(id);
  }

  // 값 하나를 넣는다. 모르는 센서면 무시하고 센다.
  setSample(sample, { pushHistory = true } = {}) {
    if (!this.byId.has(sample.sensorId)) {
      this.ignored++;
      return false;
    }
    const prev = this.latest.get(sample.sensorId);
    const entry = {
      value: Number.isFinite(sample.value) ? sample.value : null,
      quality: sample.quality ?? 'good',
      lower: sample.lower ?? null,
      upper: sample.upper ?? null,
      confidence: sample.confidence ?? null,
      alarm: sample.alarm ?? prev?.alarm ?? 'normal',
      ts: sample.ts ?? prev?.ts ?? null,
    };
    this.latest.set(sample.sensorId, entry);
    if (pushHistory) this.pushHistory(sample.sensorId, entry);
    this.version++;
    return true;
  }

  pushHistory(id, entry) {
    let h = this.history.get(id);
    if (!h) this.history.set(id, (h = []));
    h.push({ value: entry.value, lower: entry.lower, upper: entry.upper });
    if (h.length > HISTORY_LENGTH) h.shift();
  }

  setAlarm(id, to) {
    const e = this.latest.get(id);
    if (e) e.alarm = to;
    this.version++;
  }

  get(id) {
    return this.latest.get(id) ?? null;
  }

  // 장비(예: rack_01)의 지표(예: temp_in) 값
  metric(equipment, metric) {
    const id = this.byEquipment.get(equipment)?.[metric];
    return id ? this.get(id) : null;
  }

  // 장비에 달린 센서 중 가장 심한 알람 상태
  worstAlarm(equipment) {
    let worst = 'normal';
    for (const id of Object.values(this.byEquipment.get(equipment) ?? {})) {
      const a = this.latest.get(id)?.alarm ?? 'normal';
      if (ALARM_RANK[a] > ALARM_RANK[worst]) worst = a;
    }
    return worst;
  }

  countConfidence() {
    const c = { ok: 0, caution: 0, low: 0, fallback: 0 };
    for (const e of this.latest.values()) if (e.confidence in c) c[e.confidence]++;
    return c;
  }

  // 라이브 snapshot으로 초기화
  applySnapshot(snap) {
    this.clear();
    for (const s of snap.sensors) this.setSample(s, { pushHistory: false });
    this.aggregates = { ...snap.aggregates };
    this.scenario = snap.scenario;
    this.controls = snap.controls ?? null;
    // 접속 전에 일어난 알람의 변화는 모르지만 지금 알람 상태인 센서는 목록에 보인다(이전 상태는 정상으로 본다)
    for (const s of snap.sensors) {
      if (s.alarm && s.alarm !== 'normal' && this.byId.has(s.sensorId)) this.alarmLog.push({ ts: s.ts, sensorId: s.sensorId, from: 'normal', to: s.alarm, value: s.value });
    }
    this.version++;
  }
}
