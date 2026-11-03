import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { envIntensityFor, toLambert } from '../src/scene.js';

describe('envIntensityFor (하늘 반사는 유리와 금속에만)', () => {
  it('바닥, 콘크리트, 지붕, 잔디, 울타리는 반사하지 않는다', () => {
    for (const n of ['M_Asphalt', 'M_BldgConcrete', 'M_BldgRoof', 'M_BldgFloorProxy', 'M_ParkingPaint', 'M_Foliage', 'M_Trunk', 'M_Fence', 'M_BldgWallCore']) expect(envIntensityFor(n)).toBe(0);
  });
  it('유리와 금속은 반사하고 유리가 가장 세다', () => {
    expect(envIntensityFor('M_BldgGlass')).toBeGreaterThan(envIntensityFor('M_BldgPanelMetal'));
    expect(envIntensityFor('M_BldgCurtainGlass')).toBeGreaterThan(0);
    expect(envIntensityFor('M_BldgPanelMetal')).toBeGreaterThan(0);
    expect(envIntensityFor('M_BldgFan')).toBeGreaterThan(0);
  });

  it('toLambert는 색, 그림, 투명도를 옮기고 보는 각도에 따라 변하는 값(금속성, 거칠기)을 없앤다', () => {
    const map = new THREE.Texture();
    const src = new THREE.MeshStandardMaterial({ name: 'M_Asphalt', color: 0x445566, map, metalness: 0.6, roughness: 0.4, opacity: 0.7, transparent: true });
    const m = toLambert(src);
    expect(m.isMeshLambertMaterial).toBe(true);
    expect(m.name).toBe('M_Asphalt');
    expect(m.color.getHex()).toBe(0x445566);
    expect(m.map).toBe(map);
    expect(m.opacity).toBeCloseTo(0.7);
    expect(m.transparent).toBe(true);
    expect('metalness' in m).toBe(false);
    expect('roughness' in m).toBe(false);
  });
});
