// 녹화 읽기와 재생 시각 계산 (docs/18 4.3, 5.2, 5.6장).
import { CONF_BY_CODE } from './colors.js';
import { HISTORY_LENGTH } from './store.js';

// 형식 검사. 틀리면 이유와 함께 오류를 던진다(6.5장: 그 시나리오를 열지 않는다).
export function parseRecording(rec, sensorIds) {
  if (!rec || typeof rec !== 'object') throw new Error('녹화가 객체가 아니다');
  if (rec.version !== 1) throw new Error(`지원하지 않는 녹화 버전: ${rec.version}`);
  if (!Number.isInteger(rec.n) || rec.n < 1) throw new Error('녹화 길이(n)가 올바르지 않다');
  if (rec.dt !== 1) throw new Error('녹화 간격(dt)은 1초여야 한다');
  for (const id of sensorIds) {
    const v = rec.values?.[id];
    if (!Array.isArray(v) || v.length !== rec.n) throw new Error(`센서 ${id}의 값 길이가 맞지 않다`);
  }
  for (const [id, e] of Object.entries(rec.est ?? {})) {
    if (![e.lower, e.upper, e.conf].every((a) => Array.isArray(a) && a.length === rec.n)) throw new Error(`센서 ${id}의 구간 길이가 맞지 않다`);
  }
  return { ...rec, est: rec.est ?? {}, alarms: rec.alarms ?? [], events: rec.events ?? [], aggregates: rec.aggregates ?? {} };
}

export class RecordingPlayer {
  constructor(rec, store, { loop = true, speed = 1 } = {}) {
    this.rec = rec;
    this.store = store;
    this.loop = loop;
    this.speed = speed;
    this.playing = true;
    this.time = 0; // 재생 시각(초, 소수)
    this._applied = -1;
  }

  get duration() {
    return this.rec.n; // 0 ~ n(초). 마지막 값은 n-1초 칸에 있다
  }

  // 지난 시간(초)만큼 재생을 앞으로 보낸다. 한 번에 1초를 넘게 건너뛰지 않는다(탭 전환 뒤 폭주 방지, FR-54).
  advance(elapsedSec) {
    if (!this.playing) return;
    const dt = Math.min(Math.max(elapsedSec, 0), 1) * this.speed;
    let t = this.time + dt;
    if (t >= this.duration) {
      if (this.loop) t %= this.duration;
      else {
        t = this.duration - 1e-6;
        this.playing = false;
      }
    }
    this.seek(t);
  }

  // 재생 시각으로 이동하고 저장소를 그 시점의 상태로 다시 만든다(처음부터 재생한 것과 같다, FR-11).
  seek(t) {
    this.time = Math.min(Math.max(t, 0), this.duration - 1e-6);
    const i = Math.floor(this.time);
    if (i !== this._applied) this._applyAt(i);
    return i;
  }

  _applyAt(i) {
    const { rec, store } = this;
    store.latest.clear();
    store.history.clear();
    store.alarmLog = [];
    // 알람 상태는 녹화의 알람을 시각 i까지 적용해 구한다(화면이 새로 판정하지 않는다, FR-12)
    const alarmOf = new Map();
    for (const a of rec.alarms) {
      if (a.t > i) break;
      alarmOf.set(a.sensorId, a.to);
      store.alarmLog.push(a);
    }
    for (const s of store.sensors) {
      const id = s.sensorId;
      const vals = rec.values[id];
      const e = rec.est[id];
      const from = Math.max(0, i - HISTORY_LENGTH + 1);
      const hist = [];
      for (let k = from; k <= i; k++) {
        const c = e && e.conf[k];
        hist.push({ value: vals[k], lower: c ? e.lower[k] : null, upper: c ? e.upper[k] : null });
      }
      store.history.set(id, hist);
      const conf = e ? CONF_BY_CODE[e.conf[i]] : null;
      store.latest.set(id, {
        value: Number.isFinite(vals[i]) ? vals[i] : null,
        quality: Number.isFinite(vals[i]) ? 'good' : 'stale',
        lower: conf ? e.lower[i] : null,
        upper: conf ? e.upper[i] : null,
        confidence: conf,
        alarm: alarmOf.get(id) ?? 'normal',
        ts: new Date(Date.parse(rec.startTs) + i * 1000).toISOString(),
      });
    }
    store.aggregates = {};
    for (const [name, arr] of Object.entries(rec.aggregates)) store.aggregates[name] = Number.isFinite(arr[i]) ? arr[i] : null;
    store.scenario = rec.scenario;
    store.version++;
    this._applied = i;
  }
}
