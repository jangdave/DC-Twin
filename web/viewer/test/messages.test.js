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
});
