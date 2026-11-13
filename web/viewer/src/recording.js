// 녹화 읽기와 재생 시각 계산 (docs/18 4.3, 5.2, 5.6장).
import { CONF_BY_CODE } from './colors.js';
import { HISTORY_LENGTH } from './store.js';

// 형식 검사. 틀리면 이유와 함께 오류를 던진다(6.5장: 그 시나리오를 열지 않는다).
// 서버가 준 녹화도 이 검사를 지난다(docs/30 L2): 원소 형식까지 보고, 재생 중에 TypeError가 나는 일이 없게 한다.
// 값 칸의 null(그 시각 값 없음)은 허용한다(재생은 quality 'stale'로 보인다). 숫자도 null도 아닌 값은 거부한다.
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const numOrNull = (x) => x === null || Number.isFinite(x);
const seriesOk = (a, n, el = numOrNull) => Array.isArray(a) && a.length === n && a.every(el);
const confOk = (c) => c === null || (Number.isInteger(c) && c >= 0 && c < CONF_BY_CODE.length);

export function parseRecording(rec, sensorIds) {
  if (!isObj(rec)) throw new Error('녹화가 객체가 아니다');
  if (rec.version !== 1) throw new Error(`지원하지 않는 녹화 버전: ${rec.version}`);
  if (!Number.isInteger(rec.n) || rec.n < 1) throw new Error('녹화 길이(n)가 올바르지 않다');
  if (rec.dt !== 1) throw new Error('녹화 간격(dt)은 1초여야 한다');
  if (typeof rec.startTs !== 'string' || !Number.isFinite(Date.parse(rec.startTs))) throw new Error('녹화 시작 시각(startTs)이 올바르지 않다');
  if (!isObj(rec.values)) throw new Error('센서 값(values)이 객체가 아니다');
  for (const id of sensorIds) {
    const v = rec.values[id];
    if (!Array.isArray(v) || v.length !== rec.n) throw new Error(`센서 ${id}의 값 길이가 맞지 않다`);
    if (!v.every(numOrNull)) throw new Error(`센서 ${id}의 값에 숫자도 null도 아닌 것이 있다`);
  }
  if (rec.est != null && !isObj(rec.est)) throw new Error('구간(est)이 객체가 아니다');
  for (const [id, e] of Object.entries(rec.est ?? {})) {
    if (!isObj(e) || ![e.lower, e.upper, e.conf].every((a) => Array.isArray(a) && a.length === rec.n)) throw new Error(`센서 ${id}의 구간 길이가 맞지 않다`);
    if (!seriesOk(e.lower, rec.n) || !seriesOk(e.upper, rec.n) || !seriesOk(e.conf, rec.n, confOk)) throw new Error(`센서 ${id}의 구간 값 형식이 올바르지 않다`);
  }
  if (rec.aggregates != null && !isObj(rec.aggregates)) throw new Error('집계(aggregates)가 객체가 아니다');
  for (const [name, a] of Object.entries(rec.aggregates ?? {})) {
    if (!Array.isArray(a) || !a.every(numOrNull)) throw new Error(`집계 ${name}의 값 형식이 올바르지 않다`);
  }
  for (const key of ['alarms', 'events']) {
    if (rec[key] != null && !Array.isArray(rec[key])) throw new Error(`${key}가 배열이 아니다`);
  }
  let lastT = -Infinity;
  for (const a of rec.alarms ?? []) {
    // 재생은 알람을 시각 순서로 보고 i를 넘으면 멈춘다: 순서가 틀리면 알람 상태가 틀린다
    if (!isObj(a) || !Number.isFinite(a.t) || typeof a.sensorId !== 'string' || typeof a.to !== 'string') throw new Error('알람 항목 형식이 올바르지 않다(t, sensorId, to)');
    if (a.t < lastT) throw new Error('알람이 시각 순서가 아니다');
    lastT = a.t;
  }
  for (const e of rec.events ?? []) {
    if (!isObj(e) || !Number.isFinite(e.t)) throw new Error('이벤트 항목 형식이 올바르지 않다(t)');
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
