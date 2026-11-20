import { describe, expect, it } from 'vitest';
import { containmentParts, shellVisibility } from '../src/hall_shell.js';

const B = { minX: 0, maxX: 11, minZ: -13.6, maxZ: 0, height: 4 };
describe('shellVisibility', () => {
  it('방 안에서는 모두 보인다', () => {
    expect(Object.values(shellVisibility({ x: 5, y: 2, z: -6 }, B)).every(Boolean)).toBe(true);
  });
  it('서쪽 밖에서는 서쪽 벽만 숨긴다', () => {
    const v = shellVisibility({ x: -5, y: 2, z: -6 }, B);
    expect(v.wall_west).toBe(false);
    expect(v.wall_east && v.wall_north && v.wall_south && v.ceiling).toBe(true);
  });
  it('북쪽은 웹 Z가 작은 쪽이다', () => {
    expect(shellVisibility({ x: 5, y: 2, z: -20 }, B).wall_north).toBe(false);
    expect(shellVisibility({ x: 5, y: 2, z: 5 }, B).wall_south).toBe(false);
  });
  it('칸막이 천장이 있으면 그보다 위에서 조명을 숨기고, 없으면 조명 규칙이 없다(docs/35)', () => {
    const C = { ...B, ceilingZ: 3.2 };
    expect(shellVisibility({ x: 5, y: 3.6, z: -6 }, C).lightpanel).toBe(false);
    expect(shellVisibility({ x: 5, y: 2, z: -6 }, C).lightframe).toBe(true);
    expect(shellVisibility({ x: 5, y: 9, z: -6 }, B).lightpanel).toBeUndefined();
  });
  it('천장 위에서는 천장을 숨긴다', () => {
    expect(shellVisibility({ x: 5, y: 9, z: -6 }, B).ceiling).toBe(false);
  });
  it('모서리 밖 위에서는 벽 둘과 천장을 숨긴다', () => {
    const v = shellVisibility({ x: 15, y: 9, z: 4 }, B);
    expect([v.wall_east, v.wall_south, v.ceiling]).toEqual([false, false, false]);
  });
});

describe('containmentParts', () => {
  it('천장까지 닿는 열기 통로 끝 문은 미닫이 두 짝, 고정 판, 손잡이 2개로 나눈다(docs/35)', () => {
    const parts = containmentParts({ name: 'HotAisle_02_Door_W', min: [325, 500, 0], max: [330, 620, 320] });
    expect(parts.map((p) => p.kind)).toEqual(['glass', 'glass', 'transom', 'handle', 'handle']);
    expect(parts[0].max[2]).toBe(210);
    expect(parts[2].min[2]).toBe(210);
    expect(parts[2].max[2]).toBe(320);
    expect(parts[0].max[1]).toBeLessThan(parts[1].min[1]); // 두 짝 사이 틈
  });
  it('옆판과 낮은 문(CAC, 옛 장면)은 그대로 한 조각', () => {
    expect(containmentParts({ name: 'HotAisle_02_SideS', min: [330, 495, 200], max: [930, 500, 320] })).toHaveLength(1);
    expect(containmentParts({ name: 'ColdAisle_01_Door_W', min: [325, 220, 0], max: [330, 400, 205] })).toHaveLength(1);
  });
});
