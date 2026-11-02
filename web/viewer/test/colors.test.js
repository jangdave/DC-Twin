import { describe, expect, it } from 'vitest';
import { barFraction, confidenceColor, COLOR_BAD, COLOR_NONE, COLOR_STALE, sampleColor, tempColor, toCss } from '../src/colors.js';

const close = (a, b, d = 2) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

describe('온도 색 곡선 (Unreal DCTTempGradient와 같은 값)', () => {
  it('정지점', () => {
    close(tempColor(18, 18, 35), [0.05, 0.25, 1.0]);
    close(tempColor(18 + 17 / 3, 18, 35), [0.05, 0.85, 0.25]);
    close(tempColor(18 + (17 * 2) / 3, 18, 35), [1.0, 0.85, 0.05]);
    close(tempColor(35, 18, 35), [1.0, 0.08, 0.05]);
  });
  it('중간은 보간한다', () => {
    close(tempColor(18 + 17 / 6, 18, 35), [0.05, 0.55, 0.625]);
  });
  it('범위 밖은 양 끝 색으로 자른다', () => {
    close(tempColor(-50, 18, 35), tempColor(18, 18, 35));
    close(tempColor(99, 18, 35), tempColor(35, 18, 35));
  });
  it('범위 폭이 0이어도 죽지 않는다', () => {
    expect(tempColor(20, 20, 20)).toHaveLength(3);
  });
});

describe('센서 값 색', () => {
  it('값 없음, 나쁜 값, 오래된 값은 상태 색', () => {
    expect(sampleColor(null, 18, 35)).toEqual(COLOR_NONE);
    expect(sampleColor({ value: null }, 18, 35)).toEqual(COLOR_NONE);
    expect(sampleColor({ value: NaN }, 18, 35)).toEqual(COLOR_NONE);
    expect(sampleColor({ value: 99, quality: 'bad' }, 18, 35)).toEqual(COLOR_BAD);
    expect(sampleColor({ value: 25, quality: 'stale' }, 18, 35)).toEqual(COLOR_STALE);
  });
  it('좋은 값은 곡선 색', () => {
    close(sampleColor({ value: 35, quality: 'good' }, 18, 35), [1.0, 0.08, 0.05]);
  });
});

describe('신뢰 등급', () => {
  it('등급 색(Unreal DCTConfidence와 같다)', () => {
    expect(confidenceColor('ok')).toEqual([0.1, 0.8, 0.3]);
    expect(confidenceColor('caution')).toEqual([1.0, 0.8, 0.0]);
    expect(confidenceColor('low')).toEqual([1.0, 0.15, 0.1]);
    expect(confidenceColor('fallback')).toEqual([0.55, 0.55, 0.55]);
    expect(confidenceColor(null)).toEqual([0, 0, 0]);
  });
  it('막대 길이: 폭이 0이면 1, 4도 이상이면 0.15, 중간은 선형', () => {
    expect(barFraction({ confidence: 'ok', lower: 20, upper: 20 })).toBeCloseTo(1);
    expect(barFraction({ confidence: 'ok', lower: 20, upper: 24 })).toBeCloseTo(0.15);
    expect(barFraction({ confidence: 'ok', lower: 20, upper: 30 })).toBeCloseTo(0.15);
    expect(barFraction({ confidence: 'ok', lower: 20, upper: 22 })).toBeCloseTo(0.5);
  });
  it('등급이 없으면 0, 구간 없이 등급만 있으면 가장 짧게', () => {
    expect(barFraction({ confidence: null, lower: 1, upper: 2 })).toBe(0);
    expect(barFraction(null)).toBe(0);
    expect(barFraction({ confidence: 'low' })).toBeCloseTo(0.15);
  });
});

describe('화면 색 변환', () => {
  it('선형 값을 sRGB 문자열로', () => {
    expect(toCss([0, 0, 0])).toBe('rgb(0, 0, 0)');
    expect(toCss([1, 1, 1])).toBe('rgb(255, 255, 255)');
  });
});
