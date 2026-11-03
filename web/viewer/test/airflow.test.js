import { describe, expect, it } from 'vitest';
import { Airflow } from '../src/airflow.js';

// 작은 가짜 속도장: 4x4x4 칸, 장 2개(정상, 1번 CRAC 멈춤). 정상은 +x 방향 1 m/s, 멈춘 장은 -x 방향 1 m/s.
function fake() {
  const n = 4 * 4 * 4 * 3;
  const raw = new Int8Array(n * 2);
  const q = Math.round((1 / 4) * 127);
  for (let c = 0; c < n; c += 3) {
    raw[c] = q;
    raw[n + c] = -q;
  }
  const meta = { shape: [4, 4, 4], cell_m: 1, vmax_ms: 4, fields: [{ name: 'all' }, { name: 'off01' }] };
  const data = { racks: [{ name: 'Rack_01', min: [100, 100, 0], max: [200, 200, 200] }], vents: [{ name: 'Vent_01', min: [100, 100, 0], max: [300, 300, 1] }] };
  const store = { metric: () => ({ value: 35 }) };
  return new Airflow({ meta, data: raw }, data, store, ['rack_01'], ['crac_01'], { count: 50, rng: seeded() });
}

function seeded() {
  let s = 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe('Airflow', () => {
  it('정상 장에서는 +x로, 팬 0이면 멈춘 장으로 바뀐다', () => {
    const a = fake();
    const u = [0, 0, 0];
    a.sample(2, 2, 2, u);
    expect(u[0]).toBeCloseTo(1, 1);
    expect(a.setFans([0])).toBe(true);
    a.sample(2, 2, 2, u);
    expect(u[0]).toBeCloseTo(-1, 1);
  });

  it('팬 0.5이면 두 장의 가운데(0)', () => {
    const a = fake();
    a.setFans([0.5]);
    const u = [0, 0, 0];
    a.sample(2, 2, 2, u);
    expect(Math.abs(u[0])).toBeLessThan(0.05);
  });

  it('같은 팬 값이면 다시 겹치지 않는다', () => {
    const a = fake();
    expect(a.setFans([1])).toBe(false);
  });

  it('입자는 격자 안에 머물고 값이 유한하다', () => {
    const a = fake();
    for (let i = 0; i < 200; i++) a.step(0.05, i * 0.05);
    for (let p = 0; p < a.count; p++) {
      for (let d = 0; d < 3; d++) {
        const v = a.pos[p * 3 + d];
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(-0.5);
        expect(v).toBeLessThanOrEqual(4.5);
      }
    }
  });

  it('차가운 공기 색은 가까운 랙의 입구 온도를 따라간다', () => {
    const a = fake();
    a._refreshColors();
    const hot = [...a.coldColor[0]];
    a.store = { metric: (k, m) => ({ value: m === 'temp_in' ? 18 : 35 }) };
    a._refreshColors();
    expect(a.coldColor[0][0]).toBeLessThan(hot[0]); // 입구 온도가 낮으면 덜 붉다
  });

  it('가까운 랙 가중치는 칸마다 합이 1이다', () => {
    const a = fake();
    for (let c = 0; c < a.nx * a.ny; c++) {
      let sum = 0;
      for (let n = 0; n < a.K; n++) sum += a.nearW[c * a.K + n];
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('랙을 지난 입자는 랙 번호를 기억한다', () => {
    const a = fake();
    for (let i = 0; i < 400; i++) a.step(0.05, i * 0.05);
    expect([...a.heat].some((h) => h === 0)).toBe(true);
  });
});
