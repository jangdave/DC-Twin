import { describe, expect, it } from 'vitest';
import { envIntensityFor } from '../src/scene.js';

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
});
