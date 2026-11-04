import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, coolingPower } from '../src/sim/core.js';

// 집계(냉각 전력, 설비 전력, PUE)의 공유 시험 자료. 파이썬 구현이 기준이고(dct_sensors/aggregates.py), 게이트웨이도 같은 파일로 시험한다.
const V = JSON.parse(readFileSync(new URL('../../../sim/sensors/tests/aggregate_vectors.json', import.meta.url)));

describe('집계 공유 시험 자료(파이썬과 같은 값)', () => {
  it('기본 설정값이 파이썬 Config와 같다(기본값이 슬그머니 어긋나지 않는다)', () => {
    for (const [k, v] of Object.entries(V.defaults)) {
      if (k === 'crac_supply_rise') continue; // 웹 간이 계산에는 이 값이 없다(CRAC 공급 온도 센서 값을 따로 계산한다)
      expect(DEFAULT_CONFIG[k], k).toBe(v);
    }
  });

  for (const c of V.cases) {
    it(c.name, () => {
      const cfg = { ...DEFAULT_CONFIG, ...c.cfg };
      const cooling = coolingPower(cfg, c.n_crac, c.n_racks, c.fan_sum, c.it_power, c.t_supply ?? cfg.t_supply);
      const facility = c.it_power + cooling + c.it_power * cfg.loss_ratio;
      expect(cooling).toBeCloseTo(c.cooling, 5);
      expect(facility).toBeCloseTo(c.facility, 5);
      expect(c.it_power > 0 ? facility / c.it_power : 0).toBeCloseTo(c.pue, 5);
    });
  }
});
