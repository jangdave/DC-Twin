import { describe, expect, it } from 'vitest';
import { CITY, FACADES, PALETTES, SITE, baseFacade, planCity } from '../src/city.js';

describe('planCity', () => {
  const plan = planCity({ cx: 0, cz: 0, rings: 3, seed: 11 });
  const hx = (CITY.pitchX - CITY.road) / 2;
  const hz = (CITY.pitchZ - CITY.road) / 2;
  const blockOf = (x, z) => ({ x: Math.round(x / CITY.pitchX) * CITY.pitchX, z: Math.round(z / CITY.pitchZ) * CITY.pitchZ });

  it('같은 입력이면 같은 배치(재현 가능)', () => {
    expect(planCity({ cx: 0, cz: 0, rings: 3, seed: 11 }).buildings).toEqual(plan.buildings);
    expect(planCity({ cx: 0, cz: 0, rings: 3, seed: 12 }).buildings).not.toEqual(plan.buildings);
  });

  it('가운데 블록(데이터센터 부지)에는 건물, 공원, 주차장이 없다', () => {
    const inCenter = (o) => Math.abs(o.x) < hx && Math.abs(o.z) < hz;
    expect(plan.buildings.some(inCenter) || plan.parks.some(inCenter) || plan.lots.some(inCenter)).toBe(false);
    expect(plan.blocks.length).toBe(7 * 7 - 1);
  });

  it('건물의 모든 상자는 자기 블록 안에 있고 도로를 덮지 않는다', () => {
    for (const b of plan.buildings) {
      const bl = blockOf(b.x, b.z);
      for (const q of [...b.parts, ...b.roof]) {
        expect(Math.abs(q.x - bl.x) + q.w / 2).toBeLessThanOrEqual(hx + 1e-6);
        expect(Math.abs(q.z - bl.z) + q.d / 2).toBeLessThanOrEqual(hz + 1e-6);
        expect(q.h).toBeGreaterThan(0);
      }
    }
  });

  it('서로 다른 건물의 바닥은 겹치지 않는다', () => {
    const rects = plan.buildings.map((b) => ({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], c = rects[j];
        const overlap = a.x0 < c.x1 - 1e-6 && c.x0 < a.x1 - 1e-6 && a.z0 < c.z1 - 1e-6 && c.z0 < a.z1 - 1e-6;
        expect(overlap).toBe(false);
      }
    }
  });

  it('한 건물 안에서 위에 쌓은 상자는 아래 상자 안에 들어간다', () => {
    for (const b of plan.buildings.filter((x) => x.kind === 'podium' || x.kind === 'stepped')) {
      for (let i = 1; i < b.parts.length; i++) {
        const lo = b.parts[i - 1], up = b.parts[i];
        expect(up.y0).toBeCloseTo(lo.y0 + lo.h, 6);
        expect(Math.abs(up.x - lo.x) + up.w / 2).toBeLessThanOrEqual(lo.w / 2 + 1e-6);
        expect(Math.abs(up.z - lo.z) + up.d / 2).toBeLessThanOrEqual(lo.d / 2 + 1e-6);
      }
    }
  });

  it('건물이 다양하다: 외벽 5종, 모양 5종, 높이 차이, 공원과 주차장', () => {
    expect(new Set(plan.buildings.map((b) => baseFacade(b.facade))).size).toBe(5);
    expect(new Set(plan.buildings.map((b) => b.facade)).size).toBeGreaterThanOrEqual(9); // 10종 중 거의 다
    expect(plan.buildings.every((b) => FACADES.includes(b.facade))).toBe(true);
    expect(new Set(plan.buildings.map((b) => b.kind)).size).toBe(5);
    const hs = plan.buildings.map((b) => b.h);
    const mean = hs.reduce((a, v) => a + v, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((a, v) => a + (v - mean) ** 2, 0) / hs.length);
    expect(sd).toBeGreaterThan(18);
    expect(plan.parks.length).toBeGreaterThan(2);
    expect(plan.lots.length).toBeGreaterThan(2);
    expect(plan.buildings.some((b) => b.roof.length > 0)).toBe(true);
  });

  it('외벽마다 색 팔레트가 있고 건물마다 다른 색을 고른다', () => {
    for (const b of plan.buildings) expect(PALETTES[baseFacade(b.facade)][b.pal]).toBeDefined();
    const combos = new Set(plan.buildings.map((b) => `${b.facade}/${b.pal}`));
    expect(combos.size).toBeGreaterThan(30); // 외벽 10종 x 색 5종 중 30가지 넘게 쓴다
  });

  it('가까운 블록은 낮고 먼 블록에 높은 건물이 있다', () => {
    const max = (r) => Math.max(...plan.buildings.filter((b) => b.ring === r).map((b) => b.h));
    expect(max(1)).toBeLessThanOrEqual(45);
    expect(max(3)).toBeGreaterThan(max(1) * 2);
  });

  it('같은 외벽이 이웃한 건물에 계속 이어지지 않는다(덩어리 하나가 전부 같은 모양이 아님)', () => {
    let same = 0, pairs = 0;
    for (const a of plan.buildings) {
      const near = plan.buildings.filter((c) => c !== a && Math.hypot(c.x - a.x, c.z - a.z) < 70);
      for (const c of near) {
        pairs++;
        if (c.facade === a.facade && c.kind === a.kind) same++;
      }
    }
    expect(same / pairs).toBeLessThan(0.3);
  });

  it('가로등, 횡단보도, 도로가 있다', () => {
    expect(plan.lamps.length).toBeGreaterThan(200);
    expect(plan.crosswalks.length).toBe(8 * 8 * 4 * 13);
    expect(plan.roads.length).toBe(16);
  });

  it('낮은 화질(rings 2)은 더 작다', () => {
    const small = planCity({ cx: 0, cz: 0, rings: 2 });
    expect(small.buildings.length).toBeLessThan(plan.buildings.length);
    expect(small.roads.length).toBeLessThan(plan.roads.length);
  });

  // ---- 가운데 블록(부지)과 도로가 자연스럽게 이어지는지, 깜빡임 원인인 겹친 면이 없는지 ----
  const rect = (r) => ({ x0: r.x - r.w / 2, x1: r.x + r.w / 2, z0: r.z - r.d / 2, z1: r.z + r.d / 2 });
  const overlap = (a, b, tol = 1e-6) => a.x0 < b.x1 - tol && b.x0 < a.x1 - tol && a.z0 < b.z1 - tol && b.z0 < a.z1 - tol;
  const site = { x0: -SITE.hw, x1: SITE.hw, z0: -SITE.hd, z1: SITE.hd };
  const center = { x0: -hx, x1: hx, z0: -hz, z1: hz };

  it('가운데 블록의 인도와 잔디는 블록 안에 있고 부지(울타리 안)를 덮지 않는다', () => {
    for (const r of [...plan.apron.sidewalks, ...plan.apron.lawns].map(rect)) {
      expect(r.x0).toBeGreaterThanOrEqual(center.x0 - 1e-6);
      expect(r.x1).toBeLessThanOrEqual(center.x1 + 1e-6);
      expect(r.z0).toBeGreaterThanOrEqual(center.z0 - 1e-6);
      expect(r.z1).toBeLessThanOrEqual(center.z1 + 1e-6);
      expect(overlap(r, site)).toBe(false);
    }
  });

  it('가운데 블록의 인도, 잔디, 진입로는 서로 겹치지 않는다', () => {
    const all = [...plan.apron.sidewalks, ...plan.apron.lawns, plan.apron.drive].map(rect);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j])).toBe(false);
  });

  it('진입로는 정문(남쪽 가운데)에서 시작해 블록 가장자리(도로)까지 닿는다', () => {
    const d = rect(plan.apron.drive);
    expect(d.z0).toBeCloseTo(SITE.hd, 6);
    expect(d.z1).toBeCloseTo(hz, 6);
    expect(Math.abs(plan.apron.drive.x)).toBeLessThan(1e-6);
    expect(d.x1 - d.x0).toBeGreaterThanOrEqual(SITE.gateW - 1e-6);
  });

  it('가운데 블록은 인도와 잔디와 진입로로 빈틈없이 이어진다(부지 바깥 30 m 띠가 비지 않는다)', () => {
    // 울타리 바깥 1.5 m 이후부터 인도 안쪽까지를 잔디가, 그 바깥을 인도가 덮는다: 면적 합 = 블록 - 부지 - 울타리 둘레 1.5 m
    const area = (rs) => rs.reduce((a, r) => a + r.w * r.d, 0);
    const blockA = (hx * 2) * (hz * 2);
    const fenceGap = (2 * (SITE.hw + 1.5)) * (2 * (SITE.hd + 1.5)) - 4 * SITE.hw * SITE.hd;
    const total = area(plan.apron.sidewalks) + area(plan.apron.lawns) + area(plan.apron.sidewalks.length ? [plan.apron.drive] : []);
    const siteA = 4 * SITE.hw * SITE.hd;
    expect(total).toBeGreaterThan(blockA - siteA - fenceGap - 1200); // 진입로가 인도와 잔디를 대신하는 만큼의 오차를 허용
    expect(total).toBeLessThan(blockA - siteA);
  });

  it('도로 조각은 서로 겹치지 않고 교차로 정사각형과도 겹치지 않는다', () => {
    const segs = plan.roadSegments.map((s) => rect({ x: s.x, z: s.z, w: s.dir === 'x' ? s.len : CITY.road, d: s.dir === 'x' ? CITY.road : s.len }));
    const xs = plan.intersections.map((i) => rect({ x: i.x, z: i.z, w: CITY.road, d: CITY.road }));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) expect(overlap(segs[i], segs[j])).toBe(false);
      for (const q of xs) expect(overlap(segs[i], q)).toBe(false);
    }
    expect(plan.intersections.length).toBe(64);
  });
});
