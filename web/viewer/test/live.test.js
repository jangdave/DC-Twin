import { describe, expect, it } from 'vitest';
import { LiveClient, QUEUE_COMPACT_AT, compactQueue, reconnectDelay } from '../src/live.js';
import { SensorStore } from '../src/store.js';
import { sensors } from './fixtures.js';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    FakeWS.last = this;
  }
  send(data) {
    (FakeWS.sent ??= []).push(data);
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
  it('연결된 동안만 조작을 보낸다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    FakeWS.sent = [];
    expect(c.send({ type: 'control', kind: 'speed', value: 2 })).toBe(false); // 시작 전
    c.start();
    expect(c.send({ type: 'control', kind: 'speed', value: 2 })).toBe(false); // 연결 중
    FakeWS.last.onopen();
    expect(c.send({ type: 'control', kind: 'speed', value: 2 })).toBe(true);
    expect(JSON.parse(FakeWS.sent[0])).toEqual({ type: 'control', kind: 'speed', value: 2 });
    FakeWS.last.onclose();
    expect(c.send({ type: 'control', kind: 'speed', value: 2 })).toBe(false); // 끊김
  });
  it('서버의 거절 이유는 저장소에 넣지 않고 기억만 한다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'error', message: '알 수 없는 CRAC' }) });
    const v = store.version;
    expect(c.flush()).toBe(1);
    expect(c.lastError.message).toBe('알 수 없는 CRAC');
    expect(store.version).toBe(v);
  });
  it('조작 이벤트와 snapshot의 controls를 저장소에 모은다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'snapshot', sensors: [], aggregates: {}, controls: { fan: { crac_01: 0.4 }, powerScale: {} } }) });
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'scenario', name: 'normal', event: 'event', kind: 'crac_fan', target: 'crac_01', value: 0, t: 5 }) });
    c.flush();
    expect(store.controls.fan.crac_01).toBe(0.4);
    expect(store.events).toEqual([{ t: 5, kind: 'crac_fan', target: 'crac_01', value: 0 }]);
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'scenario', name: 'cooling_failure', event: 'start' }) });
    c.flush();
    expect(store.events).toEqual([]);
    expect(store.controls).toBeNull();
  });
  it('끊기기 직전에 받아 둔 메시지가 있어도 끊긴 뒤에는 값이 오래된 값으로 남는다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onopen();
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample', sensorId: 'R1-T', value: 22 }) }); // 아직 flush 전
    FakeWS.last.onclose();
    c.flush(); // 다음 프레임
    expect(store.get('R1-T')).toMatchObject({ value: 22, quality: 'stale' });
  });
});

describe('접근 토큰(서버 인증)', () => {
  const mkTok = (store, token) =>
    new LiveClient('wss://sim.example.com/ws', store, { WebSocketImpl: FakeWS, setTimeoutImpl: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeoutImpl: () => {}, token });

  it('토큰이 있으면 연결하자마자 첫 메시지로 보내고, 주소에는 붙이지 않는다', () => {
    FakeWS.sent = [];
    const c = mkTok(new SensorStore(sensors), 'secret-token-1234567890');
    c.start();
    expect(FakeWS.last.url).toBe('wss://sim.example.com/ws'); // 토큰이 주소(서버 로그, 브라우저 기록)에 들어가지 않는다
    FakeWS.last.onopen();
    expect(FakeWS.sent.map((x) => JSON.parse(x))).toEqual([{ type: 'auth', token: 'secret-token-1234567890' }]);
  });

  it('토큰이 없으면 아무것도 보내지 않는다(인증이 꺼진 서버와 같은 동작)', () => {
    FakeWS.sent = [];
    const c = mkTok(new SensorStore(sensors), null);
    c.start();
    FakeWS.last.onopen();
    expect(FakeWS.sent).toEqual([]);
  });

  it('서버가 인증을 거절(1008)하면 다시 시도하지 않고 이유를 남긴다 - 토큰이 틀린 경우', () => {
    timers.length = 0;
    const c = mkTok(new SensorStore(sensors), 'wrong-token-123456789');
    c.start();
    FakeWS.last.onopen();
    FakeWS.last.onclose({ code: 1008 });
    expect(c.state).toBe('denied');
    expect(c.denied).toBe('wrong');
    expect(c.lastError.message).toBe('접근 토큰이 맞지 않다');
    expect(timers).toEqual([]); // 재시도 예약이 없다(서버의 잠금을 부르지 않는다)
  });

  it('토큰 없이 연결했다가 거절되면 "토큰을 요구한다"로 구분한다', () => {
    timers.length = 0;
    const c = mkTok(new SensorStore(sensors), null);
    c.start();
    FakeWS.last.onopen();
    FakeWS.last.onclose({ code: 1008 });
    expect(c.denied).toBe('missing');
    expect(c.lastError.message).toBe('서버가 접근 토큰을 요구한다');
    expect(timers).toEqual([]);
  });

  it('1008이 아닌 끊김(네트워크, 1013 잠금)은 평소처럼 다시 시도한다', () => {
    timers.length = 0;
    const c = mkTok(new SensorStore(sensors), 'secret-token-1234567890');
    c.start();
    FakeWS.last.onopen();
    FakeWS.last.onclose({ code: 1013 });
    expect(c.state).toBe('closed');
    expect(timers).toHaveLength(1);
  });

  it('서버의 인증 확인 메시지(auth)는 저장소에 반영하지 않고 버린 메시지로 세지도 않는다', () => {
    const store = new SensorStore(sensors);
    const c = mkTok(store, 'secret-token-1234567890');
    c.start();
    FakeWS.last.onopen();
    const v = store.version;
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(c.dropped).toBe(0);
    c.flush();
    expect(store.version).toBe(v);
  });
});

describe('받은 메시지 큐 상한(탭이 숨겨져 화면이 못 비울 때)', () => {
  it('compactQueue: 센서마다 가장 최근 값만 남기고 사건(snapshot, alarm, scenario)은 순서대로 모두 남긴다', () => {
    const q = [
      { kind: 'snapshot' },
      { kind: 'sample', sensorId: 'A', value: 1 },
      { kind: 'sample', sensorId: 'B', value: 1 },
      { kind: 'alarm', sensorId: 'A', to: 'warn' },
      { kind: 'sample', sensorId: 'A', value: 2 },
      { kind: 'aggregate', name: 'it_power', value: 1 },
      { kind: 'scenario', event: 'event' },
      { kind: 'aggregate', name: 'it_power', value: 2 },
      { kind: 'sample', sensorId: 'A', value: 3 },
    ];
    expect(compactQueue(q).map((m) => `${m.kind}:${m.sensorId ?? m.name ?? ''}:${m.value ?? ''}`)).toEqual([
      'snapshot::', 'sample:B:1', 'alarm:A:', 'scenario::', 'aggregate:it_power:2', 'sample:A:3',
    ]);
  });

  it('메시지가 계속 쌓여도 큐 길이가 상한 근처에서 멈추고, 나중에 비우면 최신 값이 반영된다', () => {
    const store = new SensorStore(sensors);
    const c = mk(store);
    c.start();
    FakeWS.last.onopen();
    const id = sensors[0].sensorId;
    FakeWS.last.onmessage({ data: JSON.stringify({ type: 'alarm', sensorId: id, from: 'normal', to: 'warn', value: 30 }) });
    let max = 0;
    for (let i = 0; i < QUEUE_COMPACT_AT * 5; i++) {
      FakeWS.last.onmessage({ data: JSON.stringify({ type: 'sample', sensorId: id, value: i, quality: 'good', ts: '2026-10-15T09:00:00.000Z' }) });
      max = Math.max(max, c.queue.length);
    }
    expect(max).toBeLessThanOrEqual(QUEUE_COMPACT_AT);
    expect(c.compacted).toBeGreaterThan(QUEUE_COMPACT_AT * 3);
    c.flush();
    expect(store.get(id).value).toBe(QUEUE_COMPACT_AT * 5 - 1); // 마지막 값이 반영됐다
    expect(store.alarmLog.length).toBe(1); // 알람 사건은 합쳐지지 않았다
  });
});
