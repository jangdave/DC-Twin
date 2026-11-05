import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { displayForward, displayInverse } from '../src/env.js';

describe('후처리 하늘 색 보정', () => {
  it('ACES와 sRGB 변환을 거쳐 원래 색이 되는 값을 찾는다(범위 안의 색)', () => {
    for (const [hex, tol] of [[0x808080, 0.02], [0x9ec0e8, 0.02], [0xc99a85, 0.02], [0x4a5a32, 0.06], [0xf0a070, 0.06]]) { // 채도가 아주 높은 색은 ACES 출력 범위 때문에 완전히 맞추지 못한다
      const c = new THREE.Color(hex);
      const inv = displayInverse(c);
      const back = displayForward([inv.r, inv.g, inv.b]);
      const want = [c.r, c.g, c.b];
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - want[i])).toBeLessThan(tol);
    }
  });
  it('범위 밖의 짙은 파랑도 유한한 값으로 가장 가깝게 맞춘다', () => {
    const inv = displayInverse(new THREE.Color(0x1f2f5c));
    for (const v of [inv.r, inv.g, inv.b]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
