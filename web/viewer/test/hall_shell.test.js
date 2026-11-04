import { describe, expect, it } from 'vitest';
import { shellVisibility } from '../src/hall_shell.js';

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
  it('천장 위에서는 천장을 숨긴다', () => {
    expect(shellVisibility({ x: 5, y: 9, z: -6 }, B).ceiling).toBe(false);
  });
  it('모서리 밖 위에서는 벽 둘과 천장을 숨긴다', () => {
    const v = shellVisibility({ x: 15, y: 9, z: 4 }, B);
    expect([v.wall_east, v.wall_south, v.ceiling]).toEqual([false, false, false]);
  });
});
