// 브라우저 간이 시뮬레이션의 코어 (docs/21). 센서 생성기의 L0 모델과 알람 규칙을 JS로 옮겼다.
// 원본: sim/sensors/dct_sensors/{config,solvers,alarms,scenarios,generator}.py. 값은 "그럴듯하게 보이게" 정한 시각화용이며 공학적 정확성을 주장하지 않는다.

// ---- 설정(config.py와 이름과 값이 같다) ----
export const DEFAULT_CONFIG = {
  interval_s: 1.0,
  noise_temp: 0.08,
  noise_power: 0.05,
  noise_fan: 0.3,
  power_base_min: 6.0,
  power_base_max: 8.5,
  power_wobble: 0.6,
  power_period_s: 150.0,
  tau_s: 60.0,
  t_supply: 18.0,
  inlet_base_rise: 0.6,
  recirc_gain: 36.0,
  power_ref: 10.0,
  inlet_power_coeff: 6.0,
  end_rack_factor: 1.15,
  outlet_dt_ref: 10.4,
  crac_supply_rise: 6.0,
  return_offset: -3.0,
  hysteresis: 0.5,
  consecutive: 2,
  fan_power_kw: 3.0,
  cooling_base_kw: 1.0,
  loss_ratio: 0.06,
  // ---- 브라우저 쪽에서만 더한 가정값(파이썬 생성기에는 없다). 공급 온도가 기준(18도)이면 계산이 달라지지 않는다 ----
  t_supply_ref: 18.0, // 냉각 효율의 기준 공급 온도
  cooling_gain_per_c: 0.03, // 공급 온도를 1도 올릴 때 냉각 전력이 줄어드는 비율(가정값, 실측 아님). 줄어드는 방향을 보이기 위한 값이다
};

export const SUPPLY_MIN = 14;
export const SUPPLY_MAX = 27;

// 공급 온도에 따른 냉각 전력 배수(간이 가정). 기준에서 1, 올리면 줄고 내리면 늘며 0.6~1.3으로 제한한다.
export function chillerFactor(cfg, tSupply = cfg.t_supply) {
  return Math.min(Math.max(1 - cfg.cooling_gain_per_c * (tSupply - cfg.t_supply_ref), 0.6), 1.3);
}

// ---- 난수(시드를 주면 같은 값이 나온다) ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normal(rand, sd) {
  if (sd === 0) return 0;
  const u = Math.max(rand(), 1e-12);
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---- 알람 상태기계(alarms.py와 같은 규칙) ----
const NAMES = ['normal', 'warn', 'critical'];
const LEVELS = { normal: 0, warn: 1, critical: 2 };

export class AlarmState {
  constructor(warn, critical, direction = 'high', hysteresis = 0.5, consecutive = 2) {
    this.warn = warn ?? null;
    this.critical = critical ?? null;
    this.direction = direction;
    this.hysteresis = hysteresis;
    this.consecutive = consecutive;
    this.state = 'normal';
    this._run = 0;
    this._runMin = 0;
  }
  _thresholds() {
    const sgn = this.direction === 'high' ? 1 : -1;
    return [this.warn === null ? null : sgn * this.warn, this.critical === null ? null : sgn * this.critical, sgn];
  }
  _raw(v) {
    const [w, c, sgn] = this._thresholds();
    v *= sgn;
    if (c !== null && v >= c) return 2;
    if (w !== null && v >= w) return 1;
    return 0;
  }
  _hold(v) {
    const [w, c, sgn] = this._thresholds();
    v *= sgn;
    const cur = LEVELS[this.state];
    let lvl = 0;
    if (cur >= 1 && w !== null && v > w - this.hysteresis) lvl = 1;
    if (cur === 2 && c !== null && v > c - this.hysteresis) lvl = 2;
    return lvl;
  }
  breakRun() {
    this._run = this._runMin = 0;
  }
  // 상태가 바뀌면 [이전, 새 상태]를 돌려준다
  update(value) {
    const cur = LEVELS[this.state];
    const raw = this._raw(value);
    let next;
    if (raw > cur) {
      this._run += 1;
      this._runMin = this._run === 1 ? raw : Math.min(this._runMin, raw);
      if (this._run < this.consecutive) return null;
      next = this._runMin;
      this._run = this._runMin = 0;
    } else {
      this._run = this._runMin = 0;
      const hold = this._hold(value);
      if (hold >= cur) return null;
      next = hold;
    }
    const old = this.state;
    this.state = NAMES[next];
    return [old, this.state];
  }
}

export const qualityFor = (v, [lo, hi]) => (v >= lo && v <= hi ? 'good' : 'bad');

// ---- 시나리오(scenarios.py) ----
export const SCENARIOS = {
  normal: { title: '정상 운전', description: '전력이 완만하게 오르내리고 온도는 정상 범위. 알람 없음', events: [] },
  cooling_failure: {
    title: '냉각 장치 고장',
    description: '시작 후 60초에 CRAC_02 팬이 멈춘다. 가까운 랙 입구 온도가 올라 주의, 위험 알람',
    events: [{ t: 60, kind: 'crac_fan', target: 'crac_02', value: 0.0 }],
  },
  power_spike: {
    title: '전력 급증',
    description: '시작 후 30초에 Row02 랙의 전력이 40% 늘어난다. 전력과 온도 상승',
    events: [{ t: 30, kind: 'rack_power_scale', target: 'row:02', value: 1.4 }],
  },
  fan_fault: {
    title: '팬 이상',
    description: 'CRAC_01 팬 속도가 15%로 떨어진다(주의 기준 20% 이하). 팬 속도 알람, 일부 랙 온도가 완만하게 상승',
    events: [{ t: 30, kind: 'crac_fan', target: 'crac_01', value: 0.15 }],
  },
};

const numOf = (name) => Number(name.split('_')[1]);

// ---- L0 온도 모델(solvers.py의 L0Solver) ----
// racks: [{ name:'rack_01', row, no }], cracs: ['crac_01', ...]
export class L0Solver {
  constructor(racks, cracs, cfg) {
    this.cfg = cfg;
    this.racks = [...racks].sort((a, b) => a.no - b.no);
    this.cracs = [...cracs].sort();
    const nRows = Math.max(...this.racks.map((r) => r.row));
    this.perSide = Math.max(1, Math.floor(this.cracs.length / 2));
    if (Math.floor(nRows / 2) + 1 !== this.perSide) throw new Error(`줄 ${nRows}개와 CRAC ${this.cracs.length}기가 배치 규칙과 맞지 않는다`);
    this.rowOf = new Map(this.racks.map((r) => [r.name, r.row]));
    this.endRack = new Set();
    const perRow = new Map();
    for (const r of this.racks) {
      if (!perRow.has(r.row)) perRow.set(r.row, []);
      perRow.get(r.row).push(r);
    }
    for (const list of perRow.values()) {
      list.sort((a, b) => a.no - b.no);
      this.endRack.add(list[0].name);
      this.endRack.add(list[list.length - 1].name);
    }
    this.inlet = new Map(this.racks.map((r) => [r.name, cfg.t_supply + cfg.inlet_base_rise]));
    this.outlet = new Map(this.racks.map((r) => [r.name, this.inlet.get(r.name) + cfg.outlet_dt_ref * 0.7]));
    this.cracAisle = new Map(this.cracs.map((c) => [c, (numOf(c) - 1) % this.perSide]));
  }

  coolingFraction(aisle, fan) {
    const names = [aisle + 1, aisle + 1 + this.perSide].map((n) => `crac_${String(n).padStart(2, '0')}`).filter((n) => this.cracs.includes(n));
    const vals = names.map((n) => fan[n] ?? 1.0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1.0;
  }

  // fan: { crac_01: 0~1 }, power: { rack_01: kW } -> { 'rack_01/temp_in': 값, ... }
  step(dt, fan, power) {
    const cfg = this.cfg;
    const alpha = 1.0 - Math.exp(-dt / cfg.tau_s);
    const out = {};
    const rowOut = new Map();
    for (const { name: n } of this.racks) {
      const aisle = Math.floor(this.rowOf.get(n) / 2);
      const f = this.coolingFraction(aisle, fan);
      const p = power[n] ?? cfg.power_ref;
      const end = this.endRack.has(n) ? cfg.end_rack_factor : 1.0;
      const target = cfg.t_supply + cfg.inlet_base_rise + cfg.recirc_gain * (1.0 - f) * (p / cfg.power_ref) * end + cfg.inlet_power_coeff * Math.max(0.0, p / cfg.power_ref - 0.8);
      this.inlet.set(n, this.inlet.get(n) + (target - this.inlet.get(n)) * alpha);
      const targetOut = this.inlet.get(n) + (cfg.outlet_dt_ref * (p / cfg.power_ref)) / (0.5 + 0.5 * f);
      this.outlet.set(n, this.outlet.get(n) + (targetOut - this.outlet.get(n)) * alpha);
      out[`${n}/temp_in`] = this.inlet.get(n);
      out[`${n}/temp_out`] = this.outlet.get(n);
      if (!rowOut.has(aisle)) rowOut.set(aisle, []);
      rowOut.get(aisle).push(this.outlet.get(n));
    }
    const inletMean = [...this.inlet.values()].reduce((a, b) => a + b, 0) / this.inlet.size;
    for (const c of this.cracs) {
      const a = this.cracAisle.get(c);
      const fanC = fan[c] ?? 1.0;
      const vals = rowOut.get(a) ?? [inletMean];
      out[`${c}/supply_temp`] = cfg.t_supply + cfg.crac_supply_rise * (1.0 - fanC);
      out[`${c}/return_temp`] = vals.reduce((x, y) => x + y, 0) / vals.length + cfg.return_offset;
    }
    return out;
  }
}
