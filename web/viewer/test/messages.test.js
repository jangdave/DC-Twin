import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/messages.js';

describe('라이브 메시지 검사', () => {
  it('sample: 구간과 등급이 맞으면 통과', () => {
    const m = parseMessage(JSON.stringify({ type: 'sample', sensorId: 'A', value: 21.5, quality: 'good', ts: 't', lower: 20, upper: 23, confidence: 'ok' }));
    expect(m).toMatchObject({ kind: 'sample', sensorId: 'A', value: 21.5, lower: 20, upper: 23, confidence: 'ok' });
  });
  it('sample: 구간이 뒤집혔거나 등급이 틀리면 그 필드만 버린다', () => {
    const m = parseMessage({ type: 'sample', sensorId: 'A', value: 1, lower: 5, upper: 2, confidence: 'great' });
    expect(m.lower).toBeUndefined();
    expect(m.confidence).toBeUndefined();
    expect(m.value).toBe(1);
  });
  it('sample: 값이 문자열이면 값 없음', () => {
    expect(parseMessage({ type: 'sample', sensorId: 'A', value: '12' }).value).toBeNull();
  });
  it('sample: 센서 ID가 없으면 버린다', () => {
    expect(parseMessage({ type: 'sample', value: 1 })).toBeNull();
  });
  it('alarm', () => {
    expect(parseMessage({ type: 'alarm', sensorId: 'A', from: 'normal', to: 'warn', value: 27.4, ts: 't' })).toMatchObject({ kind: 'alarm', to: 'warn' });
    expect(parseMessage({ type: 'alarm', sensorId: 'A', from: 'normal', to: 'boom' })).toBeNull();
  });
  it('scenario, aggregate', () => {
    expect(parseMessage({ type: 'scenario', name: 'fan_fault', event: 'start' })).toMatchObject({ kind: 'scenario', event: 'start' });
    expect(parseMessage({ type: 'scenario', name: 'x', event: 'bad' })).toBeNull();
    expect(parseMessage({ type: 'aggregate', name: 'pue', value: 1.13 })).toMatchObject({ kind: 'aggregate', value: 1.13 });
  });
  it('snapshot: 잘못된 센서 항목은 건너뛴다, 집계는 객체나 배열', () => {
    const m = parseMessage({
      type: 'snapshot',
      scenario: 'normal',
      sensors: [{ sensorId: 'A', value: 20, alarm: 'warn' }, null, { value: 3 }, { sensorId: 'B', value: null }],
      aggregates: { pue: { name: 'pue', value: 1.2 } },
    });
    expect(m.sensors.map((s) => s.sensorId)).toEqual(['A', 'B']);
    expect(m.sensors[0].alarm).toBe('warn');
    expect(m.aggregates.pue).toBe(1.2);
    expect(m.scenario).toBe('normal');
  });
  it('JSON이 아니거나 모르는 종류는 null', () => {
    expect(parseMessage('{oops')).toBeNull();
    expect(parseMessage('[]')).toBeNull();
    expect(parseMessage({ type: 'unknown' })).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage(42)).toBeNull();
  });
  it('시나리오 이벤트의 조작 정보를 통과시키고 이상한 것은 뺀다', () => {
    const ok = parseMessage({ type: 'scenario', name: 'normal', event: 'event', kind: 'crac_fan', target: 'crac_02', value: 0, t: 12 });
    expect(ok).toMatchObject({ kind: 'scenario', event: 'event', t: 12, info: { kind: 'crac_fan', target: 'crac_02', value: 0 } });
    expect(parseMessage({ type: 'scenario', name: 'normal', event: 'event', kind: 'reboot', target: 'x', value: 1 }).info).toBeUndefined();
    expect(parseMessage({ type: 'scenario', name: 'normal', event: 'event', kind: 'crac_fan', target: 'crac_02', value: 'a' }).info).toBeUndefined();
  });
  it('error 메시지는 이유만 통과', () => {
    expect(parseMessage({ type: 'error', message: '알 수 없는 CRAC' })).toEqual({ kind: 'error', message: '알 수 없는 CRAC' });
    expect(parseMessage({ type: 'error' })).toBeNull();
  });
  it('snapshot의 controls는 장비 이름과 숫자만 남긴다', () => {
    const m = parseMessage({ type: 'snapshot', sensors: [], aggregates: {}, controls: { fan: { crac_01: 0.5, evil: 1, crac_02: 'x' }, powerScale: { rack_01: 1.2, 'row:02': 1 } } });
    expect(m.controls).toEqual({ fan: { crac_01: 0.5 }, powerScale: { rack_01: 1.2 }, supply: null });
    expect(parseMessage({ type: 'snapshot', sensors: [], aggregates: {} }).controls).toBeNull();
  });
  it('서버가 알려 주는 급기 온도는 숫자일 때만 받고, supply_temp 조작 사건을 이해한다', () => {
    const snap = (supply) => parseMessage({ type: 'snapshot', sensors: [], aggregates: {}, controls: { fan: {}, powerScale: {}, supply } });
    expect(snap(22.5).controls.supply).toBe(22.5);
    expect(snap('22').controls.supply).toBeNull();
    const ev = parseMessage({ type: 'scenario', event: 'event', name: 'normal', kind: 'supply_temp', target: 'hall', value: 24, t: 12 });
    expect(ev.info).toEqual({ kind: 'supply_temp', target: 'hall', value: 24 });
    expect(ev.t).toBe(12);
    expect(parseMessage({ type: 'scenario', event: 'event', name: 'normal', kind: 'evil', target: 'hall', value: 1 }).info).toBeUndefined();
  });
});
