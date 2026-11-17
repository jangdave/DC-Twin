import { describe, expect, it } from 'vitest';
import { Airflow, FADE_OUT, SEG } from '../src/airflow.js';

// 작은 가짜 속도장: 4x4x4 칸, 장 2개(정상, 1번 CRAC 멈춤). 정상은 +x 방향 1 m/s, 멈춘 장은 -x 방향 1 m/s.
function fake(source) {
  const n = 4 * 4 * 4 * 3;
  const raw = new Int8Array(n * 2);
  const q = Math.round((1 / 4) * 127);
  for (let c = 0; c < n; c += 3) {
    raw[c] = q;
    raw[n + c] = -q;
  }
  const meta = { shape: [4, 4, 4], cell_m: 1, vmax_ms: 4, fields: [{ name: 'all' }, { name: 'off01' }], ...(source ? { source } : {}) };
  const data = { racks: [{ name: 'Rack_01', min: [100, 100, 0], max: [200, 200, 200] }], vents: [{ name: 'Vent_01', min: [100, 100, 0], max: [300, 300, 1] }] };
  const store = { metric: () => ({ value: 35 }) };
  return new Airflow({ meta, data: raw }, data, store, ['rack_01'], ['crac_01'], { count: 50, rng: seeded() });
}

function seeded() {
  let s = 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe('Airflow', () => {
  it('차이 저장(encoding diff): 둘째 장이 정상과의 차이여도 같은 속도가 나온다', () => {
    const a = fake();
    const n = 4 * 4 * 4 * 3;
    const raw = new Int8Array(n * 2);
    const q = Math.round((1 / 4) * 127);
    for (let c = 0; c < n; c += 3) { raw[c] = q; raw[n + c] = -2 * q; } // 차이 = 멈춘 장(-q) - 정상(q)
    const meta = { shape: [4, 4, 4], cell_m: 1, vmax_ms: 4, fields: [{ name: 'all' }, { name: 'off01' }], encoding: 'diff' };
    const b = new Airflow({ meta, data: raw }, a.data, a.store, ['rack_01'], ['crac_01'], { count: 10 });
    const ua = [0, 0, 0], ub = [0, 0, 0];
    a.setFans([0]); b.setFans([0]);
    a.sample(1.5, 1.5, 1.5, ua); b.sample(1.5, 1.5, 1.5, ub);
    expect(ub[0]).toBeCloseTo(ua[0], 6);
  });
  it('흐름장이 OpenFOAM이면 흉내 내던 새는 입자를 쓰지 않는다(격벽 위 순환이 흐름장에 들어 있음)', () => {
    expect(fake('openfoam').leak).toBe(0);
    expect(fake().leak).toBeGreaterThan(0);
  });
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

  it('급기의 일부(약 10%)는 랙을 거치지 않고 위로 새며, 천장 높이를 넘으면 사라진다', () => {
    const a = fake();
    // 입자 50개로는 비율이 흔들리므로 많이 뽑아 본다
    let leaks = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      a._spawn(i % a.count);
      leaks += a.mode[i % a.count];
    }
    expect(leaks / N).toBeGreaterThan(0.07);
    expect(leaks / N).toBeLessThan(0.13);
    // 새는 입자는 속도장 대신 위로 오른다
    const b = fake();
    b.leak = 1;
    for (let p = 0; p < b.count; p++) b._spawn(p);
    const z0 = Array.from({ length: b.count }, (_, p) => b.pos[p * 3 + 2]);
    b.step(0.1, 0);
    let rose = 0;
    for (let p = 0; p < b.count; p++) if (b.pos[p * 3 + 2] > z0[p]) rose++;
    expect(rose).toBe(b.count);
    for (let i = 0; i < 80; i++) b.step(0.1, i * 0.1);
    for (let p = 0; p < b.count; p++) expect(b.pos[p * 3 + 2]).toBeLessThanOrEqual(3.65);
    expect(Number.isFinite(b.pos[0])).toBe(true);
  });

  it('새는 입자가 없으면(leak=0) 모두 속도장을 따른다', () => {
    const a = fake();
    a.leak = 0;
    for (let p = 0; p < a.count; p++) a._spawn(p);
    expect(a.mode.every((m) => m === 0)).toBe(true);
  });
  it('꼬리는 지나온 위치를 이은 꺾은선이다(마디 SEG개, 머리 쪽이 밝음)', () => {
    const a = fake();
    a.leak = 0;
    for (let i = 0; i < a.count; i++) a._spawn(i);
    expect(a.geo.attributes.position.count).toBe(a.count * SEG * 2);
    for (let k = 0; k < 20; k++) a.step(0.05, k * 0.05); // 1초: 지나온 위치가 쌓인다
    const pos = a.geo.attributes.position.array, col = a.geo.attributes.color.array;
    // 첫 입자: 마디가 이어져 있다(앞 마디의 끝 = 다음 마디의 시작), 머리는 지금 위치
    const q = 0;
    expect(pos[q]).toBeCloseTo(a.pos[0], 6);
    for (let h = 0; h < SEG - 1; h++) for (let d = 0; d < 3; d++) expect(pos[q + h * 6 + 3 + d]).toBe(pos[q + (h + 1) * 6 + d]);
    // 밝기는 머리에서 꼬리 끝으로 줄고 끝은 0
    const lum = (i) => col[i] + col[i + 1] + col[i + 2];
    expect(lum(q)).toBeGreaterThanOrEqual(lum(q + 3));
    expect(lum(q + (SEG - 1) * 6 + 3)).toBe(0);
  });
  it('흐름 밖으로 나가거나 멈춘 입자는 밝은 채로 지워지지 않고 흐려진 뒤 다시 태어난다(깜빡임 방지, 2026-11-17)', () => {
    const a = fake(); // +x 1 m/s, 4 m 격자: 입자가 곧 격자 밖으로 나간다
    a.setFans([]);
    const orig = a._spawn.bind(a);
    let n = 0, worst = 0;
    a._spawn = (p) => {
      const f = a.dying[p] && a.fadeFrom[p] > 0 ? (a.fadeFrom[p] * Math.max(0, a.life[p] - a.age[p])) / FADE_OUT : Math.min(1, a.age[p] / 0.6, (a.life[p] - a.age[p]) / 1.5);
      worst = Math.max(worst, f);
      n++;
      orig(p);
    };
    for (let k = 0; k < 600; k++) a.step(1 / 60, k / 60);
    expect(n).toBeGreaterThan(20); // 실제로 많이 나갔다
    expect(worst).toBeLessThan(0.1);
  });
});
