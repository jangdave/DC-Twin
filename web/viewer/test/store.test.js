import { describe, expect, it } from 'vitest';
import { HISTORY_LENGTH, SensorStore } from '../src/store.js';
import { sensors } from './fixtures.js';

describe('센서 값 저장소', () => {
  it('값, 구간, 등급을 보존한다', () => {
    const s = new SensorStore(sensors);
    s.setSample({ sensorId: 'R1-T', value: 22, lower: 21, upper: 23, confidence: 'ok', quality: 'good', ts: 't' });
    expect(s.get('R1-T')).toMatchObject({ value: 22, lower: 21, upper: 23, confidence: 'ok', alarm: 'normal' });
  });
  it('모르는 센서는 무시하고 센다', () => {
    const s = new SensorStore(sensors);
    expect(s.setSample({ sensorId: 'ZZZ', value: 1 })).toBe(false);
    expect(s.ignored).toBe(1);
    expect(s.latest.size).toBe(0);
  });
  it('이력은 120개를 넘지 않는다', () => {
    const s = new SensorStore(sensors);
    for (let i = 0; i < 300; i++) s.setSample({ sensorId: 'R1-T', value: i });
    expect(s.history.get('R1-T')).toHaveLength(HISTORY_LENGTH);
    expect(s.history.get('R1-T').at(-1).value).toBe(299);
  });
  it('알람 상태는 다음 값에서도 유지된다', () => {
    const s = new SensorStore(sensors);
    s.setSample({ sensorId: 'R1-T', value: 30 });
    s.setAlarm('R1-T', 'warn');
    s.setSample({ sensorId: 'R1-T', value: 30.5 });
    expect(s.get('R1-T').alarm).toBe('warn');
  });
  it('장비별 지표와 가장 심한 알람', () => {
    const s = new SensorStore(sensors);
    s.setSample({ sensorId: 'R1-T', value: 30 });
    s.setAlarm('R1-T', 'critical');
    expect(s.metric('rack_01', 'temp_in').value).toBe(30);
    expect(s.worstAlarm('rack_01')).toBe('critical');
    expect(s.worstAlarm('rack_02')).toBe('normal');
    expect(s.metric('rack_99', 'temp_in')).toBeNull();
  });
  it('등급 개수', () => {
    const s = new SensorStore(sensors);
    s.setSample({ sensorId: 'R1-T', value: 1, confidence: 'low' });
    s.setSample({ sensorId: 'R2-T', value: 1, confidence: 'ok' });
    expect(s.countConfidence()).toEqual({ ok: 1, caution: 0, low: 1, fallback: 0 });
  });
  it('snapshot으로 통째로 초기화', () => {
    const s = new SensorStore(sensors);
    s.setSample({ sensorId: 'R1-T', value: 1 });
    s.applySnapshot({ sensors: [{ sensorId: 'R2-T', value: 20, alarm: 'warn' }], aggregates: { pue: 1.2 }, scenario: 'x' });
    expect(s.get('R1-T')).toBeNull();
    expect(s.get('R2-T').alarm).toBe('warn');
    expect(s.aggregates.pue).toBe(1.2);
  });
  it('snapshot에서 이미 알람인 센서는 알람 목록에 올린다', () => {
    const s = new SensorStore(sensors);
    s.applySnapshot({ sensors: [{ sensorId: 'R2-T', value: 30, alarm: 'warn', ts: 't1' }, { sensorId: 'R1-T', value: 20, alarm: 'normal' }, { sensorId: 'ZZZ', value: 1, alarm: 'critical' }], aggregates: {}, scenario: null });
    expect(s.alarmLog).toEqual([{ ts: 't1', sensorId: 'R2-T', from: 'normal', to: 'warn', value: 30 }]);
  });
});
