import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AlarmState, SCENARIOS, mulberry32 } from '../src/sim/core.js';
import { SimEngine, layoutFrom } from '../src/sim/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(path.join(HERE, p), 'utf8'));
const sensors = read('../public/data/sensors.json');
const scene = read('../public/data/scene.json');
const fixture = read('fixtures/sim_l0.json');
const vectors = read('../../../sim/sensors/tests/alarm_vectors.json').cases; // 센서 생성기와 게이트웨이가 같이 쓰는 시험 자료
const { racks, cracs } = layoutFrom(scene.racks, sensors);

describe('알람 판정(파이썬, 게이트웨이와 같은 시험 자료)', () => {
  for (const c of vectors) {
    it(c.name, () => {
      const a = new AlarmState(c.warn, c.critical, c.direction, c.hysteresis, c.consecutive);
      const got = [];
      c.values.forEach((v, index) => {
        if (v === null) return a.breakRun();
        const tr = a.update(v);
        if (tr) got.push({ index, from: tr[0], to: tr[1] });
      });
      expect(got).toEqual(c.transitions);
    });
  }
});

describe('L0 모델이 파이썬과 같은 값을 낸다', () => {
  for (const run of fixture.runs) {
    it(`${run.scenario}: 센서 값, 집계, 알람 전이가 일치`, () => {
      const eng = new SimEngine({ sensors, racks, cracs, cfg: run.config, basePower: run.basePower, phase: run.phase });
      eng.startScenario(run.scenario);
      const alarms = [];
      let worst = 0;
      for (let i = 0; i < fixture.steps; i++) {
        const msgs = eng.step();
        const frame = i % fixture.every === 0 ? run.frames[i / fixture.every] : null;
        const vals = {};
        const agg = {};
        for (const m of msgs) {
          if (m.kind === 'sample') vals[m.sensorId] = m.value;
          else if (m.kind === 'aggregate') agg[m.name] = m.value;
          else if (m.kind === 'alarm') alarms.push({ t: i, sensorId: m.sensorId, from: m.from, to: m.to });
        }
        if (frame) {
          for (const [id, v] of Object.entries(frame.values)) worst = Math.max(worst, Math.abs(vals[id] - v));
          for (const [k, v] of Object.entries(frame.aggregates)) worst = Math.max(worst, Math.abs(agg[k] - v));
          expect(Object.keys(vals).length).toBe(Object.keys(frame.values).length);
        }
      }
      expect(worst).toBeLessThan(0.0015); // 소수 3자리 반올림 차이만 허용
      expect(alarms).toEqual(run.alarms);
    });
  }
});

describe('엔진 동작', () => {
  const mk = (seed = 3) => new SimEngine({ sensors, racks, cracs, seed });
  it('같은 시드는 같은 값, 다른 시드는 다른 값', () => {
    const a = mk(5);
    const b = mk(5);
    const c = mk(6);
    const va = a.step().filter((m) => m.kind === 'sample').map((m) => m.value);
    expect(b.step().filter((m) => m.kind === 'sample').map((m) => m.value)).toEqual(va);
    expect(c.step().filter((m) => m.kind === 'sample').map((m) => m.value)).not.toEqual(va);
  });
  it('한 단계에 센서 204개와 집계 5개', () => {
    const m = mk().step();
    expect(m.filter((x) => x.kind === 'sample')).toHaveLength(204);
    expect(m.filter((x) => x.kind === 'aggregate')).toHaveLength(5);
  });
  it('CRAC를 끄면 가까운 랙 입구 온도가 오르고 알람이 난다', () => {
    const e = mk();
    e.startScenario('normal');
    for (let i = 0; i < 30; i++) e.step();
    const ev = e.setFan('crac_02', 0);
    expect(ev.info).toEqual({ kind: 'crac_fan', target: 'crac_02', value: 0 });
    const tin = [...e.solver.inlet.values()];
    const before = Math.max(...tin);
    const alarms = [];
    for (let i = 0; i < 300; i++) alarms.push(...e.step().filter((m) => m.kind === 'alarm'));
    expect(Math.max(...e.solver.inlet.values())).toBeGreaterThan(before + 3);
    expect(alarms.length).toBeGreaterThan(0);
  });
  it('줄 전력을 올리면 전력 합계가 오른다', () => {
    const e = mk();
    const it0 = e.step().find((m) => m.kind === 'aggregate' && m.name === 'it_power').value;
    e.setPowerScale('row:02', 2);
    const it1 = e.step().find((m) => m.kind === 'aggregate' && m.name === 'it_power').value;
    expect(it1).toBeGreaterThan(it0 + 10);
  });
  it('모르는 장비는 null, 값은 0~100%와 0~3배로 제한', () => {
    const e = mk();
    expect(e.setFan('crac_99', 0)).toBeNull();
    expect(e.setPowerScale('rack_99', 1)).toBeNull();
    e.setFan('crac_01', 5);
    expect(e.fan.crac_01).toBe(1);
    e.setPowerScale('rack_01', 9);
    expect(e.powerScale.rack_01).toBe(3);
  });
  it('시나리오 시작은 상태를 되돌리고 이벤트를 정해진 시각에 적용', () => {
    const e = mk();
    e.setFan('crac_03', 0);
    const start = e.startScenario('cooling_failure');
    expect(start).toMatchObject({ kind: 'scenario', event: 'start', name: 'cooling_failure' });
    expect(e.fan.crac_03).toBe(1);
    expect(e.t).toBe(0);
    let eventAt = null;
    for (let i = 0; i < 70; i++) {
      const ev = e.step().find((m) => m.kind === 'scenario');
      if (ev && eventAt === null) eventAt = i;
    }
    expect(eventAt).toBe(60);
    expect(e.fan.crac_02).toBe(0);
    expect(() => e.startScenario('nope')).toThrow();
  });
  it('시나리오 4개의 설명과 이름', () => {
    expect(Object.keys(SCENARIOS)).toEqual(['normal', 'cooling_failure', 'power_spike', 'fan_fault']);
    for (const s of Object.values(SCENARIOS)) expect(s.title.length).toBeGreaterThan(1);
  });
  it('난수는 0~1', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});
