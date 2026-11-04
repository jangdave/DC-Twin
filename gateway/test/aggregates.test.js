// 집계 공유 시험 자료(파이썬과 웹과 같은 값). 기준은 파이썬 `dct_sensors/aggregates.py`이고 자료는 `sim/sensors/tests/aggregate_vectors.json`이다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_CONFIG, Gateway, coolingPower } from '../src/core.js';

const V = JSON.parse(readFileSync(new URL('../../sim/sensors/tests/aggregate_vectors.json', import.meta.url), 'utf8'));
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

test('기본 설정값이 파이썬 Config와 같다(기본값이 슬그머니 어긋나지 않는다)', () => {
  for (const [k, v] of Object.entries(V.defaults)) assert.equal(DEFAULT_CONFIG[camel(k)], v, k);
});

for (const c of V.cases) {
  test(`공유 시험 자료: ${c.name}`, () => {
    const cfg = { ...DEFAULT_CONFIG };
    for (const [k, v] of Object.entries(c.cfg)) cfg[camel(k)] = v;
    const cooling = coolingPower(cfg, { nCrac: c.n_crac, nRacks: c.n_racks, fanSum: c.fan_sum, it: c.it_power, tSupply: c.t_supply ?? cfg.tSupply });
    const facility = c.it_power + cooling + c.it_power * cfg.lossRatio;
    assert.ok(Math.abs(cooling - c.cooling) < 1e-5, `냉각 ${cooling} vs ${c.cooling}`);
    assert.ok(Math.abs(facility - c.facility) < 1e-5);
    assert.ok(Math.abs((c.it_power > 0 ? facility / c.it_power : 0) - c.pue) < 1e-5);
  });
}

// ---- 게이트웨이 통합: 급기 온도를 센서에서 추정하고 부하를 반영한다 ----
const rackSensor = (n, equipmentType = 'rack') => ({ sensorId: `H01-RK${n}-POWER`, topic: `dct/v1/hall01/rack_${n}/power`, equipmentPath: `/DC/Hall01/Row01/Rack_${n}`, equipmentType, metric: 'power', unit: 'kW', range: [0, 15], warn: 10, critical: 13 });
const crac = (n, metric, unit) => ({ sensorId: `H01-CR${n}-${metric.toUpperCase().replace('_', '-')}`, topic: `dct/v1/hall01/crac_${n}/${metric}`, equipmentPath: `/DC/Hall01/Cooling/CRAC_${n}`, equipmentType: 'crac', metric, unit, range: [0, 100], warn: null, critical: null });
const manifest = { version: 1, hall: 'hall01', sensors: [rackSensor('01'), rackSensor('02'), crac('01', 'fan_speed', 'percent'), crac('01', 'supply_temp', 'degC')] };
const T0 = Date.parse('2026-10-15T09:00:00.000Z');
const send = (g, s, id, value, unit) => g.ingest({ sensorId: id, ts: new Date(T0 + s * 1000).toISOString(), value, unit });

function aggregateAt(supplyTemp, fan, rackKw) {
  const g = new Gateway(manifest);
  g.on('log', () => {});
  const out = [];
  g.on('aggregate', (m) => out.push(m));
  send(g, 0, 'H01-RK01-POWER', rackKw, 'kW');
  send(g, 0, 'H01-RK02-POWER', rackKw, 'kW');
  send(g, 0, 'H01-CR01-FAN-SPEED', fan * 100, 'percent');
  send(g, 0, 'H01-CR01-SUPPLY-TEMP', supplyTemp, 'degC');
  send(g, 1, 'H01-RK01-POWER', rackKw, 'kW'); // 다음 시각이 들어오면 앞 시각의 집계가 닫힌다
  return Object.fromEntries(out.map((m) => [m.name, m.value]));
}

test('게이트웨이: 공급 온도 센서에서 급기 온도를 추정해 냉각 전력에 반영한다', () => {
  const base = aggregateAt(18, 1, 7.3333333);
  const hot = aggregateAt(24, 1, 7.3333333); // 팬 100%이면 공급 온도 = 급기 온도
  assert.ok(Math.abs(hot.cooling_power / base.cooling_power - 0.82) < 0.002, `${hot.cooling_power} / ${base.cooling_power}`);
});

test('게이트웨이: 팬이 줄어 공급 온도가 오른 것을 급기 온도 상승으로 착각하지 않는다', () => {
  const full = aggregateAt(18, 1, 7.3333333);
  const half = aggregateAt(18 + 6 * 0.5, 0.5, 7.3333333); // 급기는 18도 그대로, 팬 50%라 공급 온도가 21도
  // 팬 전력이 줄어든 만큼만 줄고(급기 효율 배수는 1), 18도로 추정한다
  const expected = (1 + 3 * 0.5) / (1 + 3 * 1);
  assert.ok(Math.abs(half.cooling_power / full.cooling_power - expected) < 0.002, `${half.cooling_power / full.cooling_power} vs ${expected}`);
});

test('게이트웨이: 부하가 늘면 냉각 전력이 는다(예전에는 고정이었다)', () => {
  const lo = aggregateAt(18, 1, 5.0);
  const hi = aggregateAt(18, 1, 10.0);
  assert.ok(hi.cooling_power > lo.cooling_power * 1.2, `${lo.cooling_power} -> ${hi.cooling_power}`);
});

test('게이트웨이: 공급 온도 센서가 없으면 기본 급기 온도를 쓴다', () => {
  const g = new Gateway({ ...manifest, sensors: manifest.sensors.filter((s) => s.metric !== 'supply_temp') });
  g.on('log', () => {});
  const out = [];
  g.on('aggregate', (m) => out.push(m));
  send(g, 0, 'H01-RK01-POWER', 7.3333333, 'kW');
  send(g, 0, 'H01-RK02-POWER', 7.3333333, 'kW');
  send(g, 0, 'H01-CR01-FAN-SPEED', 100, 'percent');
  send(g, 1, 'H01-RK01-POWER', 7.3333333, 'kW');
  const cooling = out.find((m) => m.name === 'cooling_power').value;
  assert.ok(Math.abs(cooling - 4.0) < 0.01, String(cooling)); // 1 + 3 = 4, 배수 모두 1
});
