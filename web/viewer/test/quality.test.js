import { describe, expect, it } from 'vitest';
import { FHD, detectQuality, lowerTier, pixelRatioFor, SETTINGS } from '../src/quality.js';

describe('detectQuality', () => {
  it('주소의 q가 있으면 그대로 쓴다', () => {
    expect(detectQuality('low', { width: 2000, cores: 32 })).toBe('low');
    expect(detectQuality('high', { width: 300, coarsePointer: true })).toBe('high');
  });
  it('자동 시험 브라우저는 보통으로 고정(q가 있으면 q가 먼저)', () => {
    expect(detectQuality(null, { width: 390, coarsePointer: true, automated: true })).toBe('mid');
    expect(detectQuality('low', { automated: true })).toBe('low');
  });
  it('모바일과 태블릿(터치, 좁은 화면)은 보통, 확실히 느린 기기만 낮음(2026-11-11 사용자 요청)', () => {
    expect(detectQuality(null, { width: 390, coarsePointer: true })).toBe('mid'); // iPhone(사파리는 메모리를 알려 주지 않음)
    expect(detectQuality(null, { width: 412, coarsePointer: true, deviceMemory: 8, cores: 8 })).toBe('mid'); // 갤럭시: 사양이 높아도 보통
    expect(detectQuality(null, { width: 1024, coarsePointer: true, deviceMemory: 8, cores: 8 })).toBe('mid'); // 태블릿
    expect(detectQuality(null, { width: 600 })).toBe('mid');
    expect(detectQuality(null, { width: 390, coarsePointer: true, deviceMemory: 2 })).toBe('low');
    expect(detectQuality(null, { width: 390, coarsePointer: true, cores: 2 })).toBe('low');
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

describe('해상도 상한(일반 기준 FHD)', () => {
  it('보통 단계의 상한은 FHD 화소 수다', () => {
    expect(SETTINGS.mid.maxPixels).toBe(FHD);
    expect(SETTINGS.low.maxPixels).toBeLessThan(FHD);
    expect(SETTINGS.high.maxPixels).toBeGreaterThan(FHD);
  });
  it('FHD 화면(배율 1)은 보통 단계에서 그대로 그린다', () => {
    expect(pixelRatioFor(SETTINGS.mid, 1920, 1080, 1)).toBe(1);
  });
  it('FHD보다 큰 화면은 보통 단계에서 FHD 화소 수에 맞춰 낮춘다', () => {
    const pr = pixelRatioFor(SETTINGS.mid, 3840, 2160, 1); // 4K, 배율 1
    expect(pr).toBeCloseTo(0.5, 5);
    expect(3840 * 2160 * pr * pr).toBeLessThanOrEqual(FHD + 1);
    const pr2 = pixelRatioFor(SETTINGS.mid, 1920, 1080, 2); // FHD 크기에 배율 2(고밀도 화면)는 화소 수 상한 때문에 1.5가 아니라 1
    expect(pr2).toBe(1);
  });
  it('작은 화면은 기기 배율과 단계 배율 상한 중 작은 값을 쓴다', () => {
    expect(pixelRatioFor(SETTINGS.mid, 800, 600, 3)).toBe(1.5);
    expect(pixelRatioFor(SETTINGS.high, 800, 600, 3)).toBe(2);
    expect(pixelRatioFor(SETTINGS.low, 800, 600, 3)).toBe(1);
  });
  it('0.5 아래로는 내리지 않는다', () => {
    expect(pixelRatioFor(SETTINGS.low, 7680, 4320, 1)).toBe(0.5);
  });
  it('낮은 단계는 후처리를 끄고 높음 단계만 접촉 그림자를 쓴다', () => {
    expect(SETTINGS.low.bloom).toBe(0);
    expect(SETTINGS.mid.bloom).toBeGreaterThan(0);
    expect(SETTINGS.mid.ao).toBe(false);
    expect(SETTINGS.high.ao).toBe(true);
  });
});
