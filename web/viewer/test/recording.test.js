import { describe, expect, it } from 'vitest';
import { parseRecording, RecordingPlayer } from '../src/recording.js';
import { SensorStore } from '../src/store.js';
import { makeRec, sensors } from './fixtures.js';

const ids = sensors.map((s) => s.sensorId);
const snapshotOf = (store) => JSON.stringify({ latest: [...store.latest], history: [...store.history], log: store.alarmLog, agg: store.aggregates });

describe('녹화 형식 검사', () => {
  it('정상 녹화는 통과', () => {
    expect(() => parseRecording(makeRec(), ids)).not.toThrow();
  });
  it('버전, 간격, 길이가 틀리면 이유와 함께 거부', () => {
    expect(() => parseRecording({ ...makeRec(), version: 2 }, ids)).toThrow(/버전/);
    expect(() => parseRecording({ ...makeRec(), dt: 5 }, ids)).toThrow(/간격/);
    const r = makeRec();
    r.values['R1-T'].pop();
    expect(() => parseRecording(r, ids)).toThrow(/R1-T/);
    const e = makeRec();
    e.est['R1-T'].conf.pop();
    expect(() => parseRecording(e, ids)).toThrow(/구간/);
    expect(() => parseRecording(null, ids)).toThrow();
  });
  it('원소 형식이 틀리면 재생 전에 거부하고, 값 칸의 null은 허용(docs/30 L2)', () => {
    const bad = (f) => {
      const r = makeRec();
      f(r);
      return () => parseRecording(r, ids);
    };
    expect(bad((r) => (r.values['R2-T'][3] = null))).not.toThrow(); // 그 시각 값 없음
    expect(bad((r) => (r.values['R2-T'][3] = '21'))).toThrow(/R2-T/);
    expect(bad((r) => (r.values = null))).toThrow(/values/);
    expect(bad((r) => (r.est['R1-T'] = null))).toThrow(/R1-T/);
    expect(bad((r) => (r.est['R1-T'].conf[0] = 9))).toThrow(/구간 값/);
    expect(bad((r) => (r.est['R1-T'].lower[0] = 'x'))).toThrow(/구간 값/);
    expect(bad((r) => (r.est['R1-T'].conf[0] = null))).not.toThrow();
    expect(bad((r) => (r.aggregates.pue = null))).toThrow(/pue/);
    expect(bad((r) => (r.aggregates = []))).toThrow(/aggregates/);
    expect(bad((r) => (r.alarms = {}))).toThrow(/alarms/);
    expect(bad((r) => (r.alarms[0] = null))).toThrow(/알람/);
    expect(bad((r) => r.alarms.reverse())).toThrow(/순서/);
    expect(bad((r) => (r.events = [{ kind: 'x' }]))).toThrow(/이벤트/);
    expect(bad((r) => (r.startTs = 'nope'))).toThrow(/startTs/);
  });
  it('값 칸에 null이 있어도 재생이 멈추지 않고 그 시각은 stale로 보인다', () => {
    const r = makeRec();
    r.values['R2-T'][3] = null;
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(r, ids), store);
    p.seek(3.2);
    expect(store.latest.get('R2-T')).toMatchObject({ value: null, quality: 'stale' });
    p.seek(4.1);
    expect(store.latest.get('R2-T').quality).toBe('good');
  });
});

describe('녹화 재생', () => {
  it('시각별 값, 구간, 등급, 알람', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.seek(5.4);
    const e = store.get('R1-T');
    expect(e.value).toBeCloseTo(25);
    expect(e.confidence).toBe('caution');
    expect(e.lower).toBeCloseTo(19 + (8 * 5) / 9);
    expect(e.alarm).toBe('warn');
    expect(store.get('R2-T').confidence).toBeNull();
    expect(store.aggregates.it_power).toBeCloseTo(400 + (10 * 5) / 9);
  });
  it('FR-11: 뒤로 가거나 건너뛴 상태가 처음부터 재생한 것과 같다', () => {
    const a = new SensorStore(sensors);
    const b = new SensorStore(sensors);
    const pa = new RecordingPlayer(parseRecording(makeRec(), ids), a);
    const pb = new RecordingPlayer(parseRecording(makeRec(), ids), b);
    for (let t = 0; t <= 8; t++) pa.seek(t);
    pb.seek(9);
    pb.seek(2);
    pb.seek(8);
    expect(snapshotOf(b)).toBe(snapshotOf(a));
  });
  it('FR-12: 알람 목록은 재생 시각까지만', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.seek(3);
    expect(store.alarmLog).toHaveLength(0);
    p.seek(4);
    expect(store.alarmLog.map((a) => a.to)).toEqual(['warn']);
    p.seek(9);
    expect(store.alarmLog.map((a) => a.to)).toEqual(['warn', 'critical']);
    p.seek(1);
    expect(store.alarmLog).toHaveLength(0);
    expect(store.get('R1-T').alarm).toBe('normal');
  });
  it('이력은 시각까지만 쌓인다', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.seek(5);
    expect(store.history.get('R1-T')).toHaveLength(6);
  });
  it('반복: 끝을 넘으면 처음으로, 반복 끄면 멈춘다', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store, { speed: 10 });
    p.time = 9.5;
    p.advance(0.9); // 9.5 + 9 = 18.5 -> 8.5
    expect(p.time).toBeCloseTo(8.5);
    const q = new RecordingPlayer(parseRecording(makeRec(), ids), store, { loop: false, speed: 10 });
    q.time = 9.5;
    q.advance(0.9);
    expect(q.playing).toBe(false);
    expect(q.time).toBeLessThan(10);
  });
  it('FR-54: 한 번에 1초보다 크게 건너뛰지 않는다', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.advance(600); // 탭이 10분 뒤에 돌아옴
    expect(p.time).toBeCloseTo(1);
  });
  it('일시정지 중에는 움직이지 않는다', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.playing = false;
    p.advance(0.5);
    expect(p.time).toBe(0);
  });
  it('범위를 벗어난 이동은 자른다', () => {
    const store = new SensorStore(sensors);
    const p = new RecordingPlayer(parseRecording(makeRec(), ids), store);
    p.seek(-5);
    expect(p.time).toBe(0);
    p.seek(999);
    expect(p.time).toBeLessThan(10);
  });
  it('값이 비어 있으면 오래된 값', () => {
    const store = new SensorStore(sensors);
    const r = makeRec();
    r.values['R2-T'][3] = null;
    const p = new RecordingPlayer(parseRecording(r, ids), store);
    p.seek(3);
    expect(store.get('R2-T').quality).toBe('stale');
    expect(store.get('R2-T').value).toBeNull();
  });
});
