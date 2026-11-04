import { describe, expect, it } from 'vitest';
import { bootProgress, eventFraction, STEPS } from '../src/boot.js';

describe('bootProgress', () => {
  it('아무것도 안 했으면 0, 모두 끝나면 1', () => {
    expect(bootProgress({})).toBe(0);
    expect(bootProgress({ data: 'done', model: 'done', flow: 'done' })).toBe(1);
  });
  it('건너뜀은 끝난 것으로 센다(실패해도 막대가 멈추지 않는다)', () => {
    expect(bootProgress({ data: 'done', model: 'skip', flow: 'skip' })).toBe(1);
  });
  it('가중치대로 합친다: 모델이 70%', () => {
    expect(bootProgress({ data: 'done', model: 0.5 })).toBeCloseTo(0.1 + 0.35, 5);
  });
  it('범위를 벗어난 값은 0~1로 자른다', () => {
    expect(bootProgress({ model: 5 })).toBeCloseTo(0.7, 5);
    expect(bootProgress({ model: -2 })).toBe(0);
  });
  it('가중치 합은 100', () => {
    expect(STEPS.reduce((a, s) => a + s.weight, 0)).toBe(100);
  });
});

describe('eventFraction', () => {
  it('크기를 알 때만 비율을 낸다', () => {
    expect(eventFraction({ lengthComputable: true, loaded: 25, total: 100 })).toBe(0.25);
    expect(eventFraction({ lengthComputable: false, loaded: 25, total: 0 })).toBeNull();
    expect(eventFraction(undefined)).toBeNull();
  });
  it('받은 양이 전체보다 커도 1을 넘지 않는다', () => {
    expect(eventFraction({ lengthComputable: true, loaded: 150, total: 100 })).toBe(1);
  });
});
