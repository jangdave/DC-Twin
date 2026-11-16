import { describe, expect, it } from 'vitest';
import { Airflow, flowFromJob } from '../src/airflow.js';

// 서버 작업 흐름(sequence, sim/sensors/dct_sensors/web_flow.py): 장 2개(팬 모두 켬, CRAC_01 끔). 첫 장은 +x 1 m/s, 둘째 장은 -x 2 m/s.
function jobFlow() {
  const n = 2 * 2 * 2 * 3;
  const raw = new Int8Array(n * 2);
  const q = (v) => Math.round((v / 8) * 127);
  for (let c = 0; c < n; c += 3) {
    raw[c] = q(1);
    raw[n + c] = q(-2);
  }
  const b64 = Buffer.from(raw.buffer).toString('base64');
  return {
    version: 1, source: 'openfoam', encoding: 'sequence', shape: [2, 2, 2], cell_m: 1, vmax_ms: 8, z0_m: 0,
    fields: [{ from_s: 0, fan: { crac_01: 1, crac_02: 1 } }, { from_s: 60, fan: { crac_01: 0, crac_02: 1 } }],
    data_b64: b64,
  };
}
const scene = { racks: [{ name: 'Rack_01', min: [100, 100, 0], max: [200, 200, 200] }], vents: [{ name: 'Vent_01', min: [0, 0, 0], max: [100, 100, 1] }] };
const store = { metric: () => ({ value: 30 }) };

describe('작업 흐름(flowFromJob, sequence)', () => {
  it('base64를 int8로 풀고 크기가 맞지 않으면 거절한다', () => {
    const f = flowFromJob(jobFlow());
    expect(f.data).toBeInstanceOf(Int8Array);
    expect(f.data.length).toBe(2 * 2 * 2 * 3 * 2);
    expect(f.data[24]).toBeLessThan(0); // 음수도 그대로(부호 있는 8비트)
    expect(f.meta.data_b64).toBeUndefined();
    expect(() => flowFromJob({ ...jobFlow(), shape: [3, 2, 2] })).toThrow();
    expect(() => flowFromJob({ ...jobFlow(), encoding: 'diff' })).toThrow();
  });
  it('지금 팬 값과 가장 가까운 장을 겹치지 않고 그대로 쓴다', () => {
    const a = new Airflow(flowFromJob(jobFlow()), scene, store, ['rack_01'], ['crac_01', 'crac_02'], { count: 10 });
    const u = [0, 0, 0];
    a.sample(0.5, 0.5, 0.5, u);
    expect(u[0]).toBeCloseTo((Math.round(127 / 8) * 8) / 127, 5); // 첫 장: 약 +1 m/s
    expect(a.setFans([0.1, 1])).toBe(true); // CRAC_01이 거의 꺼짐 -> 둘째 장
    a.sample(0.5, 0.5, 0.5, u);
    expect(u[0]).toBeCloseTo((Math.round(-254 / 8) * 8) / 127, 5); // 약 -2 m/s (섞지 않음)
    expect(a.setFans([0.05, 1])).toBe(false); // 같은 장이면 다시 계산하지 않는다
    expect(a.leak).toBe(0); // OpenFOAM 흐름이라 새는 입자를 흉내 내지 않는다
  });
});
