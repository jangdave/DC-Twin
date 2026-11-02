import { describe, expect, it } from 'vitest';
import { LiveClient, reconnectDelay } from '../src/live.js';
import { SensorStore } from '../src/store.js';
import { sensors } from './fixtures.js';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    FakeWS.last = this;
  }
  close() {
    this.onclose?.();
  }
}
const timers = [];
const mk = (store) =>
  new LiveClient('ws://127.0.0.1:8080/ws', store, {
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeoutImpl: () => {},
  });

describe('재접속 간격', () => {
  it('2초부터 늘어나 10초에서 멈춘다', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000]);
  });
});

describe('라이브 연결', () => {
  it('snapshot과 sample을 쌓았다가 flush에서 한 번에 반영', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onopen();
    expect(c.state).toBe('open');
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'snapshot', sensors: [{ sensorId: 'R1-T', value: 20 }], aggregates: {} }) });
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample', sensorId: 'R1-T', value: 25, confidence: 'low', lower: 23, upper: 28 }) });
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'alarm', sensorId: 'R1-T', from: 'normal', to: 'warn', value: 25, ts: 't' }) });
    expect(store.get('R1-T')).toBeNull(); // 아직 반영 전
    expect(c.flush()).toBe(3);
    expect(store.get('R1-T')).toMatchObject({ value: 25, confidence: 'low', alarm: 'warn' });
    expect(store.alarmLog).toHaveLength(1);
  });
  it('형식이 틀린 메시지는 버리고 센다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onmessage({ data: '{oops' });
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample' }) });
    expect(c.dropped).toBe(2);
    expect(c.flush()).toBe(0);
  });
  it('끊기면 값을 오래된 값으로 바꾸고 재접속을 예약', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onopen();
    store.setSample({ sensorId: 'R1-T', value: 22 });
    timers.length = 0;
    FakeWS.last.onclose();
    expect(c.state).toBe('closed');
    expect(store.get('R1-T').quality).toBe('stale');
    expect(timers.at(-1).ms).toBe(2000);
    timers.at(-1).fn();
    expect(c.state).toBe('connecting');
  });
  it('연결되면 재접속 횟수를 되돌린다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onclose();
    FakeWS.last.onclose();
    expect(c.attempt).toBeGreaterThan(0);
    c.stop();
    c.start();
    FakeWS.last.onopen();
    expect(c.attempt).toBe(0);
  });
  it('stop 뒤에는 재접속하지 않는다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    timers.length = 0;
    c.stop();
    expect(timers).toHaveLength(0);
    expect(c.state).toBe('idle');
  });
  it('stop 직후 start해도 옛 연결의 늦은 close가 재접속을 만들지 않는다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    const old = FakeWS.last;
    c.stop();
    c.start();
    timers.length = 0;
    old.onclose?.();
    expect(timers).toHaveLength(0);
    expect(c.state).toBe('connecting');
  });
  it('새 시나리오가 시작되면 값과 알람 목록을 비운다(게이트웨이도 초기화한다)', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample', sensorId: 'R1-T', value: 25 }) });
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'alarm', sensorId: 'R1-T', from: 'normal', to: 'warn', value: 25, ts: 't' }) });
    c.flush();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'scenario', name: 'fan_fault', event: 'start' }) });
    c.flush();
    expect(store.get('R1-T')).toBeNull();
    expect(store.alarmLog).toHaveLength(0);
    expect(store.scenario).toBe('fan_fault');
  });
  it('모르는 센서 메시지는 무시', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample', sensorId: 'ZZZ', value: 1 }) });
    c.flush();
    expect(store.ignored).toBe(1);
  });
});
