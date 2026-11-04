import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RESPONSE, capacity, compare, responseFor, rowInlets, snapshot, supplyRoom } from '../src/sim/insight.js';
import { DEFAULT_CONFIG, SCENARIOS, chillerFactor } from '../src/sim/core.js';
import { SimEngine } from '../src/sim/engine.js';

const stub = (metrics, aggregates = {}, alarms = []) => ({
  aggregates,
  metric: (k, m) => metrics[`${k}/${m}`] ?? null,
  latest: new Map(alarms.map((a, i) => [i, { alarm: a }])),
});

describe('snapshot', () => {
  it('집계, 가장 높은 입구 온도, 주의 기준까지의 여유, 알람 수를 모은다', () => {
    const s = snapshot(
      stub({ 'rack_01/temp_in': { value: 21 }, 'rack_02/temp_in': { value: 24.5 } }, { it_power: 400, cooling_power: 30, facility_power: 454, pue: 1.13, energy_kwh: 2 }, ['normal', 'warn']),
      ['rack_01', 'rack_02'],
    );
    expect(s).toMatchObject({ it: 400, cooling: 30, facility: 454, maxIn: 24.5, maxRack: 'rack_02', margin: 2.5, alarms: 1 });
  });
  it('값이 없으면 null', () => {
    const s = snapshot(stub({}), ['rack_01']);
    expect(s.maxIn).toBeNull();
    expect(s.margin).toBeNull();
  });
});

describe('compare', () => {
  const base = { facility: 460, cooling: 32, pue: 1.13, maxIn: 20, alarms: 0 };
  it('줄어든 항목은 좋음, 늘어난 항목은 나쁨', () => {
    const r = Object.fromEntries(compare(base, { facility: 450, cooling: 28, pue: 1.11, maxIn: 23, alarms: 2 }).map((x) => [x.key, x]));
    expect(r.facility).toMatchObject({ dir: 'down', good: true });
    expect(r.facility.delta).toBeCloseTo(-10);
    expect(r.facility.pct).toBeCloseTo(-2.17, 1);
    expect(r.maxIn).toMatchObject({ dir: 'up', good: false });
    expect(r.alarms).toMatchObject({ dir: 'up', good: false });
  });
  it('거의 같으면 same', () => {
    expect(compare(base, { ...base, facility: 460.02 }).find((x) => x.key === 'facility').dir).toBe('same');
  });
});

describe('capacity와 rowInlets', () => {
  const m = { 'rack_01/power': { value: 9.6 }, 'rack_02/power': { value: 6 }, 'rack_03/power': { value: 10.5 } };
  it('여유가 적은 순서로 돌려주고 90% 이상, 초과를 센다', () => {
    const c = capacity(stub(m), ['rack_01', 'rack_02', 'rack_03']);
    expect(c.racks.map((r) => r.key)).toEqual(['rack_03', 'rack_01', 'rack_02']);
    expect(c.near).toBe(2);
    expect(c.over).toBe(1);
    expect(c.totalHeadroom).toBeCloseTo(30 - 26.1, 5);
  });
  it('줄별로 가장 높은 입구 온도와 과냉각 의심을 가른다', () => {
    const t = stub({ 'rack_01/temp_in': { value: 19 }, 'rack_02/temp_in': { value: 20 }, 'rack_03/temp_in': { value: 25 } });
    const r = rowInlets(t, ['rack_01', 'rack_02', 'rack_03'], (k) => (k === 'rack_03' ? 2 : 1));
    expect(r).toEqual([
      { row: 1, max: 20, margin: 7, overcooled: true },
      { row: 2, max: 25, margin: 2, overcooled: false },
    ]);
  });
  it('공급 온도를 올릴 수 있는 폭은 안전 여유를 뺀 값이고 음수가 되지 않는다', () => {
    expect(supplyRoom(21)).toBeCloseTo(4.5);
    expect(supplyRoom(30)).toBe(0);
    expect(supplyRoom(null)).toBeNull();
  });
});

describe('대응 순서', () => {
  it('엔진의 모든 시나리오에 안내가 있다', () => {
    for (const k of Object.keys(SCENARIOS)) expect(RESPONSE[k], k).toBeTruthy();
    expect(responseFor('없는것').steps.length).toBeGreaterThan(0);
  });
});

describe('미리 계산한 상태 비교 안내', () => {
  it('급기와 부하 항목에 비교 순서가 있다', () => {
    expect(responseFor('supply_22').title).toBe('급기 온도 비교');
    expect(responseFor('load_130').title).toBe('부하 비교');
    expect(responseFor('load_70').steps.length).toBeGreaterThan(2);
  });
});

describe('공급 온도와 냉각 효율 모델(가정)', () => {
  it('기준(18도)에서는 배수가 1이다', () => {
    expect(chillerFactor(DEFAULT_CONFIG, 18)).toBe(1);
  });
  it('올리면 줄고 내리면 늘며 범위를 넘지 않는다', () => {
    expect(chillerFactor(DEFAULT_CONFIG, 22)).toBeCloseTo(0.88);
    expect(chillerFactor(DEFAULT_CONFIG, 14)).toBeCloseTo(1.12);
    expect(chillerFactor(DEFAULT_CONFIG, 100)).toBe(0.6);
    expect(chillerFactor(DEFAULT_CONFIG, -50)).toBe(1.3);
  });

  const sensors = JSON.parse(readFileSync(new URL('../public/data/sensors.json', import.meta.url)));
  const scene = JSON.parse(readFileSync(new URL('../public/data/scene.json', import.meta.url)));
  const make = () => {
    const racks = scene.racks.map((r) => ({ name: r.name.toLowerCase(), row: r.row, no: Number(r.name.split('_')[1]) }));
    const cracs = [...new Set(sensors.filter((s) => s.equipmentType === 'crac').map((s) => s.equipment))].sort();
    return new SimEngine({ sensors, racks, cracs, seed: 3 });
  };
  const agg = (msgs, name) => msgs.find((m) => m.kind === 'aggregate' && m.name === name).value;
  const maxIn = (ms) => Math.max(...ms.filter((m) => m.kind === 'sample' && m.sensorId.endsWith('TEMP-IN')).map((m) => m.value));

  it('같은 조건에서 공급 온도만 올리면 냉각 전력과 PUE가 줄고 IT 전력은 같다', () => {
    const a = make();
    const b = make();
    b.setSupply(22);
    const ma = a.step();
    const mb = b.step();
    expect(agg(mb, 'cooling_power') / agg(ma, 'cooling_power')).toBeCloseTo(0.88, 2);
    expect(agg(mb, 'it_power')).toBeCloseTo(agg(ma, 'it_power'), 3);
    expect(agg(mb, 'pue')).toBeLessThan(agg(ma, 'pue'));
  });
  it('공급 온도를 올리면 입구 온도도 같이 올라간다(방향)', () => {
    const a = make();
    const b = make();
    b.setSupply(24);
    let ta = 0;
    let tb = 0;
    for (let i = 0; i < 600; i++) {
      ta = maxIn(a.step());
      tb = maxIn(b.step());
    }
    expect(tb - ta).toBeGreaterThan(3);
  });
  it('범위를 벗어난 값은 14~27로 잘리고, 시나리오를 다시 시작하면 처음 값으로 돌아간다', () => {
    const e = make();
    e.setSupply(99);
    expect(e.cfg.t_supply).toBe(27);
    e.setSupply(-3);
    expect(e.cfg.t_supply).toBe(14);
    e.startScenario('normal');
    expect(e.cfg.t_supply).toBe(18);
  });
});
