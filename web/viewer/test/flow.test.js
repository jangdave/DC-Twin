import { describe, expect, it } from 'vitest';
import { COMMANDS, CommandQueue, FlowState, parseCommand, summarize } from '../src/flow.js';
import { SensorStore } from '../src/store.js';
import { sensors } from './fixtures.js';

describe('화면 단계', () => {
  it('처음은 외관이고 홀로 들어갔다가 뒤로 돌아온다', () => {
    const f = new FlowState();
    expect(f.stage).toBe('exterior');
    expect(f.goto('hall')).toBe(true);
    expect(f.stage).toBe('hall');
    expect(f.back()).toBe(true);
    expect(f.stage).toBe('exterior');
  });
  it('외관에서 뒤로 가기나 같은 단계로 이동은 바뀌지 않는다', () => {
    const f = new FlowState();
    expect(f.back()).toBe(false);
    expect(f.goto('exterior')).toBe(false);
  });
  it('모르는 단계와 둘러보기(웹 범위 밖)는 거부', () => {
    const f = new FlowState();
    expect(f.goto('walk')).toBe(false);
    expect(f.goto('nowhere')).toBe(false);
    expect(f.stage).toBe('exterior');
    expect(new FlowState('walk').stage).toBe('exterior');
  });
});

describe('명령 번호표', () => {
  it('번호가 문서와 같고 서로 다르다', () => {
    expect(COMMANDS).toEqual({ 'view.goto': 10001, 'view.back': 10002, 'view.select': 10003, 'view.layer': 10004, 'sim.scenario': 10005 });
    expect(new Set(Object.values(COMMANDS)).size).toBe(5);
  });
});

describe('명령 검사', () => {
  it('올바른 명령은 통과', () => {
    expect(parseCommand({ name: 'view.goto', value: 'hall' })).toEqual({ name: 'view.goto', value: 'hall' });
    expect(parseCommand({ name: 'view.select', value: 'rack_01' })).toEqual({ name: 'view.select', value: 'rack_01' });
    expect(parseCommand({ name: 'view.select', value: '' })).toEqual({ name: 'view.select', value: null });
    expect(parseCommand({ name: 'view.layer', value: 'power' })).toBeTruthy();
    expect(parseCommand({ name: 'view.back' })).toBeTruthy();
    expect(parseCommand({ name: 'sim.scenario', value: 'fan_fault' })).toBeTruthy();
  });
  it('알 수 없는 이름과 틀린 값은 null', () => {
    for (const c of [null, {}, { name: 'x.y' }, { name: 'view.goto', value: 'walk' }, { name: 'view.select', value: '<img>' }, { name: 'view.layer', value: 'x' }, { name: 'sim.scenario', value: 'A B' }, { name: 5 }]) {
      expect(parseCommand(c)).toBeNull();
    }
  });
});

describe('명령 큐', () => {
  it('준비 전에는 쌓고 준비되면 순서대로 한 번씩 실행', () => {
    const ran = [];
    const q = new CommandQueue((c) => ran.push(c));
    q.push({ name: 'view.goto', value: 'hall' });
    q.push({ name: 'sim.scenario', value: 'fan_fault' });
    expect(ran).toHaveLength(0);
    q.setReady();
    expect(ran.map((c) => c.name)).toEqual(['view.goto', 'sim.scenario']);
    q.setReady();
    expect(ran).toHaveLength(2);
  });
  it('준비 전 같은 이름이 여럿이면 마지막 것만 실행', () => {
    const ran = [];
    const q = new CommandQueue((c) => ran.push(c));
    q.push({ name: 'view.select', value: 'rack_01' });
    q.push({ name: 'view.select', value: 'rack_02' });
    q.setReady();
    expect(ran).toEqual([{ name: 'view.select', value: 'rack_02' }]);
  });
  it('준비 뒤에는 바로 실행하고, 틀린 명령은 버리며 횟수를 센다', () => {
    const ran = [];
    const q = new CommandQueue((c) => ran.push(c));
    q.setReady();
    expect(q.push({ name: 'view.back' })).toBe(true);
    expect(q.push({ name: 'nope' })).toBe(false);
    expect(q.push({ name: 'view.goto', value: 'walk' })).toBe(false);
    expect(ran).toHaveLength(1);
    expect(q.rejected).toBe(2);
  });
});

describe('건물 요약', () => {
  it('값이 없으면 데이터 없음', () => {
    const s = summarize(new SensorStore(sensors), ['rack_01']);
    expect(s).toMatchObject({ hasData: false, alarms: 0, maxTempIn: null, itPower: null, pue: null });
  });
  it('알람 수와 최고 입구 온도, 집계를 모은다', () => {
    const store = new SensorStore(sensors);
    store.setSample({ sensorId: 'R1-T', value: 27.5 });
    store.setAlarm('R1-T', 'warn');
    store.aggregates = { it_power: 120.5, pue: 1.4 };
    const eq = [...store.byEquipment.entries()].find(([, m]) => m.temp_in === 'R1-T')?.[0];
    const s = summarize(store, [eq]);
    expect(s).toMatchObject({ hasData: true, alarms: 1, maxTempIn: 27.5, maxRack: eq, itPower: 120.5, pue: 1.4 });
  });
});
