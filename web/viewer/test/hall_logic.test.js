import { describe, expect, it } from 'vitest';
import { ServerModel, monitorSeed, rackGrid } from '../src/hall_logic.js';

const layout = { cracs: ['crac_01', 'crac_02'], racks: [{ name: 'rack_01', row: 1 }, { name: 'rack_02', row: 1 }, { name: 'rack_03', row: 2 }] };

describe('ServerModel(서버 조작 상태 접기)', () => {
  it('snapshot의 controls에서 시작하고 이벤트를 순서대로 접는다', () => {
    const store = { controls: { fan: { crac_02: 0.5 }, powerScale: { rack_03: 1.2 }, supply: 19 }, events: [] };
    const m = new ServerModel(layout).sync(store);
    expect(m.fan).toEqual({ crac_01: 1, crac_02: 0.5 });
    expect(m.powerScale).toEqual({ rack_01: 1, rack_02: 1, rack_03: 1.2 });
    expect(m.supply).toBe(19);
    store.events.push({ kind: 'crac_fan', target: 'crac_01', value: 0 }, { kind: 'rack_power_scale', target: 'row:01', value: 1.4 }, { kind: 'supply_temp', value: 21 });
    m.sync(store);
    expect(m.fan.crac_01).toBe(0);
    expect(m.powerScale).toEqual({ rack_01: 1.4, rack_02: 1.4, rack_03: 1.2 });
    expect(m.supply).toBe(21);
  });
  it('모르는 대상은 무시하고, 새 snapshot이나 이벤트가 줄면 처음부터 다시 접는다', () => {
    const store = { controls: {}, events: [{ kind: 'crac_fan', target: 'crac_99', value: 0 }, { kind: 'rack_power_scale', target: 'rack_99', value: 2 }] };
    const m = new ServerModel(layout).sync(store);
    expect(m.fan).toEqual({ crac_01: 1, crac_02: 1 });
    expect(Object.keys(m.powerScale)).toEqual(['rack_01', 'rack_02', 'rack_03']);
    store.events.push({ kind: 'supply_temp', value: 20 }, { kind: 'crac_fan', target: 'crac_02', value: 0.3 }); // 저장소의 이벤트는 뒤에 쌓인다
    m.sync(store);
    expect(m.supply).toBe(20);
    store.events = []; // 새 시작(이벤트가 줄었다)
    m.sync(store);
    expect(m.supply).toBeNull();
    expect(m.fan.crac_02).toBe(1);
    store.controls = { supply: 23 }; // 새 snapshot
    m.sync(store);
    expect(m.supply).toBe(23);
  });
});

describe('monitorSeed(간이 계산 시작값)', () => {
  const vals = { 'rack_01/temp_in': 22, 'rack_01/temp_out': 32, 'crac_01/fan_speed': 100, 'crac_02/fan_speed': 40, 'crac_01/supply_temp': 18.2, 'crac_02/supply_temp': 16 };
  const store = { metric: (k, m) => (vals[`${k}/${m}`] === undefined ? null : { value: vals[`${k}/${m}`] }) };
  it('랙 입구·출구, 팬 비율(0~1), 급기는 팬이 정상인 공조기 중 가장 낮은 공급 온도', () => {
    const s = monitorSeed(store, ['rack_01', 'rack_02'], ['crac_01', 'crac_02']);
    expect(s.inlet).toEqual({ rack_01: 22, rack_02: undefined });
    expect(s.outlet.rack_01).toBe(32);
    expect(s.fan).toEqual({ crac_01: 1, crac_02: 0.4 });
    expect(s.supply).toBe(18.2); // crac_02는 팬이 줄어 제외
  });
  it('서버가 알려 준 급기 설정값이 있으면 그것을 쓴다', () => {
    expect(monitorSeed(store, [], ['crac_01'], 20.5).supply).toBe(20.5);
    expect(monitorSeed({ metric: () => null }, [], ['crac_01']).supply).toBeNull();
  });
});

describe('rackGrid(방향키 랙 이동)', () => {
  const racks = [
    { name: 'Rack_02', row: 1, min: [60] }, { name: 'Rack_01', row: 1, min: [0] }, { name: 'Rack_03', row: 1, min: [120] },
    { name: 'Rack_04', row: 2, min: [0] }, { name: 'Rack_05', row: 2, min: [60] },
  ];
  const next = rackGrid(racks);
  it('선택이 없으면 첫 랙, 같은 줄은 x 순서로 좌우, 줄은 위아래, 끝에서는 멈춤', () => {
    expect(next(null, 0, 1)).toBe('rack_02');
    expect(next('rack_01', 0, 1)).toBe('rack_02');
    expect(next('rack_01', 0, -1)).toBe('rack_01');
    expect(next('rack_03', 1, 0)).toBe('rack_05'); // 아래 줄이 짧으면 끝 칸
    expect(next('rack_04', 1, 0)).toBe('rack_04');
    expect(next('rack_05', -1, 0)).toBe('rack_02');
  });
});
