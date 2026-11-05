import { describe, expect, it } from 'vitest';
import { dailyProfile, hourOf, todayUsage, usedKwh } from '../src/daily.js';

describe('하루 사용량(더미 데이터)', () => {
  const p = dailyProfile();
  it('시간별 전력이 24개이고 같은 시드면 같다', () => {
    expect(p).toHaveLength(24);
    expect(dailyProfile()).toEqual(p);
    expect(dailyProfile(8)).not.toEqual(p);
  });
  it('값이 현실적인 범위(설비 전력 400~560 kW)이고 오후가 새벽보다 높다', () => {
    for (const v of p) {
      expect(v).toBeGreaterThan(400);
      expect(v).toBeLessThan(560);
    }
    expect(Math.max(...p.slice(11, 17))).toBeGreaterThan(Math.min(...p.slice(0, 6)));
  });
  it('0시는 0이고 하루 끝은 시간별 합이며 시간이 갈수록 늘기만 한다', () => {
    expect(usedKwh(p, 0)).toBe(0);
    expect(usedKwh(p, 24)).toBeCloseTo(p.reduce((a, b) => a + b, 0), 6);
    let prev = -1;
    for (let h = 0; h <= 24; h += 0.25) {
      const v = usedKwh(p, h);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('한 시간 안에서는 그 시간의 전력으로 일정하게 늘어난다(1시간 = 그 시간의 kW)', () => {
    expect(usedKwh(p, 10.5) - usedKwh(p, 10)).toBeCloseTo(p[10] * 0.5, 6);
  });
  it('컴퓨터 시계로만 정해진다: 같은 시각이면 같은 값, 재생과 무관', () => {
    const a = new Date(2026, 10, 5, 15, 30, 0);
    expect(hourOf(a)).toBeCloseTo(15.5, 6);
    expect(todayUsage(a).kwh).toBe(todayUsage(new Date(a)).kwh);
    expect(todayUsage(new Date(2026, 10, 5, 16, 0, 0)).kwh).toBeGreaterThan(todayUsage(a).kwh);
    expect(todayUsage(a).total).toBeCloseTo(usedKwh(p, 24), 6);
  });
});
