import { describe, expect, it } from 'vitest';
import { CITY, planCity } from '../src/city.js';

describe('planCity', () => {
  const plan = planCity({ cx: 0, cz: 0, rings: 3, seed: 11 });

  it('같은 입력이면 같은 배치(재현 가능)', () => {
    expect(planCity({ cx: 0, cz: 0, rings: 3, seed: 11 }).buildings).toEqual(plan.buildings);
    expect(planCity({ cx: 0, cz: 0, rings: 3, seed: 12 }).buildings).not.toEqual(plan.buildings);
  });

  it('가운데 블록(데이터센터 부지)에는 건물이 없다', () => {
    const hx = (CITY.pitchX - CITY.road) / 2;
    const hz = (CITY.pitchZ - CITY.road) / 2;
    for (const b of plan.buildings) expect(Math.abs(b.x) < hx && Math.abs(b.z) < hz).toBe(false);
    expect(plan.blocks.length).toBe(7 * 7 - 1);
  });

  it('건물은 자기 블록 안에 있고 도로를 덮지 않는다', () => {
    for (const b of plan.buildings) {
      const bi = Math.round(b.x / CITY.pitchX), bj = Math.round(b.z / CITY.pitchZ);
      const bx = bi * CITY.pitchX, bz = bj * CITY.pitchZ;
      expect(Math.abs(b.x - bx) + b.w / 2).toBeLessThanOrEqual((CITY.pitchX - CITY.road) / 2);
      expect(Math.abs(b.z - bz) + b.d / 2).toBeLessThanOrEqual((CITY.pitchZ - CITY.road) / 2);
      expect(b.w).toBeGreaterThan(5);
      expect(b.d).toBeGreaterThan(5);
    }
  });

  it('가까운 블록은 낮고 먼 블록은 높아질 수 있다', () => {
    const max = (r) => Math.max(...plan.buildings.filter((b) => b.ring === r).map((b) => b.h));
    expect(max(1)).toBeLessThanOrEqual(26);
    expect(max(3)).toBeGreaterThan(max(1));
  });

  it('낮은 화질(rings 2)은 더 작다', () => {
    const small = planCity({ cx: 0, cz: 0, rings: 2 });
    expect(small.buildings.length).toBeLessThan(plan.buildings.length);
    expect(small.roads.length).toBeLessThan(plan.roads.length);
  });
});
