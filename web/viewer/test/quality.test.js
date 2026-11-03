import { describe, expect, it } from 'vitest';
import { detectQuality, lowerTier, SETTINGS } from '../src/quality.js';

describe('detectQuality', () => {
  it('주소의 q가 있으면 그대로 쓴다', () => {
    expect(detectQuality('low', { width: 2000, cores: 32 })).toBe('low');
    expect(detectQuality('high', { width: 300, coarsePointer: true })).toBe('high');
  });
  it('자동 시험 브라우저는 보통으로 고정(q가 있으면 q가 먼저)', () => {
    expect(detectQuality(null, { width: 390, coarsePointer: true, automated: true })).toBe('mid');
    expect(detectQuality('low', { automated: true })).toBe('low');
  });
  it('모바일(터치, 좁은 화면)은 낮음', () => {
    expect(detectQuality(null, { width: 390, coarsePointer: true })).toBe('low');
    expect(detectQuality(null, { width: 600 })).toBe('low');
  });
  it('메모리 4GB 이하나 코어 4개 이하는 낮음', () => {
    expect(detectQuality(null, { width: 1440, deviceMemory: 4 })).toBe('low');
    expect(detectQuality(null, { width: 1440, cores: 4 })).toBe('low');
  });
  it('중간 사양은 보통, 넉넉하면 높음, 모르면 높음', () => {
    expect(detectQuality(null, { width: 1440, deviceMemory: 8, cores: 6 })).toBe('mid');
    expect(detectQuality(null, { width: 1440, deviceMemory: 8, cores: 16 })).toBe('high');
    expect(detectQuality(null, { width: 1440 })).toBe('high');
  });
  it('한 단계 낮추기와 단계별 설정이 점점 가벼워진다', () => {
    expect(lowerTier('high')).toBe('mid');
    expect(lowerTier('mid')).toBe('low');
    expect(lowerTier('low')).toBeNull();
    expect(SETTINGS.low.particles).toBeLessThan(SETTINGS.mid.particles);
    expect(SETTINGS.mid.shadow).toBeLessThan(SETTINGS.high.shadow);
    expect(SETTINGS.low.cars).toBe(0);
  });
});
