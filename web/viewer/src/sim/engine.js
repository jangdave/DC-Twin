// 브라우저 간이 시뮬레이션 엔진 (docs/21). generator.py의 한 단계를 JS로 옮겼다.
// 한 단계 = 시뮬레이션 1초. step()은 저장소에 바로 넣을 수 있는 메시지(parseMessage와 같은 모양)를 돌려준다.
import { AlarmState, DEFAULT_CONFIG, L0Solver, SCENARIOS, SUPPLY_MAX, SUPPLY_MIN, coolingPower, mulberry32, normal, qualityFor } from './core.js';

const START_MS = Date.parse('2026-10-15T09:00:00.000Z');

// 장면(scene.json)과 센서 목록(sensors.json)에서 엔진 입력을 만든다.
export function layoutFrom(sceneRacks, sensors) {
  const racks = sceneRacks.map((r) => ({ name: r.name.toLowerCase(), row: r.row, no: Number(r.name.split('_')[1]) }));
  const cracs = [...new Set(sensors.filter((s) => s.equipmentType === 'crac').map((s) => s.equipment))].sort();
  return { racks, cracs };
}

export class SimEngine {
  // opts: { sensors, racks, cracs, cfg, seed, basePower, phase } (basePower, phase는 시험에서 파이썬과 맞출 때만 넣는다)
  constructor({ sensors, racks, cracs, cfg = {}, seed = 1, basePower = null, phase = null }) {
    this.sensors = sensors;
    this.racks = racks;
    this.cracs = cracs;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this._supply0 = this.cfg.t_supply; // 처음 설정값. 시나리오를 다시 시작하면 여기로 돌아간다
    this.seed = seed;
    this._fixedPower = basePower;
    this._fixedPhase = phase;
    this.reset();
  }

  reset() {
    const cfg = this.cfg;
    cfg.t_supply = this._supply0;
    this.rand = mulberry32(this.seed);
    this.basePower = {};
    this.phase = {};
    for (const r of this.racks) {
      this.basePower[r.name] = this._fixedPower?.[r.name] ?? cfg.power_base_min + this.rand() * (cfg.power_base_max - cfg.power_base_min);
      this.phase[r.name] = this._fixedPhase?.[r.name] ?? this.rand() * 2 * Math.PI;
    }
    this.fan = Object.fromEntries(this.cracs.map((c) => [c, 1.0]));
    this.powerScale = Object.fromEntries(this.racks.map((r) => [r.name, 1.0]));
    this.solver = new L0Solver(this.racks, this.cracs, cfg);
    this.alarms = new Map(this.sensors.map((s) => [s.sensorId, new AlarmState(s.warn, s.critical, s.direction, cfg.hysteresis, cfg.consecutive)]));
    this.t = 0;
    this.energyKwh = 0;
    this.scenario = null;
    this._events = [];
    this._fired = new Set();
  }

  // 모니터링의 지금 값에서 시작한다(docs/31: 간이 계산 = 모니터링 상태에서 팬·급기만 바꿔 빠르게).
  // seed: { inlet: {rack_01: 도}, outlet: {...}, fan: {crac_01: 0~1}, supply: 도 }. 없는 값은 기본값 그대로 둔다.
  startFrom(seed) {
    this.reset();
    this.scenario = 'monitor';
    this._events = [];
    const ok = (v) => typeof v === 'number' && Number.isFinite(v);
    if (ok(seed?.supply)) this.cfg.t_supply = Math.min(Math.max(seed.supply, SUPPLY_MIN), SUPPLY_MAX);
    for (const [c, v] of Object.entries(seed?.fan ?? {})) if (c in this.fan && ok(v)) this.fan[c] = Math.min(Math.max(v, 0), 1);
    for (const [r, v] of Object.entries(seed?.inlet ?? {})) if (this.solver.inlet.has(r) && ok(v)) this.solver.inlet.set(r, v);
    for (const [r, v] of Object.entries(seed?.outlet ?? {})) if (this.solver.outlet.has(r) && ok(v)) this.solver.outlet.set(r, v);
    return { kind: 'scenario', name: 'monitor', event: 'start', ts: this.ts() };
  }

  // 시나리오를 처음부터 시작한다(상태를 모두 되돌린다).
  startScenario(name) {
    const sc = SCENARIOS[name];
    if (!sc) throw new Error(`알 수 없는 시나리오: ${name}`);
    this.reset();
    this.scenario = name;
    this._events = sc.events;
    return { kind: 'scenario', name, event: 'start', ts: this.ts() };
  }

  ts(t = this.t) {
    return new Date(START_MS + t * 1000).toISOString();
  }

  // ---- 직접 조작 ----
  setFan(crac, value) {
    if (!(crac in this.fan)) return null;
    this.fan[crac] = Math.min(Math.max(value, 0), 1);
    return { kind: 'scenario', name: this.scenario ?? 'manual', event: 'event', ts: this.ts(), info: { kind: 'crac_fan', target: crac, value: this.fan[crac] } };
  }

  // 냉각 장치가 내보내는 공기의 목표 온도(공급 온도 설정). 입구 온도 목표와 냉각 전력(가정 모델)에 반영된다.
  setSupply(value) {
    this.cfg.t_supply = Math.min(Math.max(value, SUPPLY_MIN), SUPPLY_MAX);
    return { kind: 'scenario', name: this.scenario ?? 'manual', event: 'event', ts: this.ts(), info: { kind: 'supply_temp', value: this.cfg.t_supply } };
  }

  // target: 'rack_21' 또는 'row:02'
  setPowerScale(target, value) {
    const v = Math.min(Math.max(value, 0), 3);
    const list = target.startsWith('row:') ? this.racks.filter((r) => r.row === Number(target.slice(4))).map((r) => r.name) : this.racks.some((r) => r.name === target) ? [target] : [];
    if (!list.length) return null;
    for (const n of list) this.powerScale[n] = v;
    return { kind: 'scenario', name: this.scenario ?? 'manual', event: 'event', ts: this.ts(), info: { kind: 'rack_power_scale', target, value: v } };
  }

  _applyEvents(out) {
    this._events.forEach((e, i) => {
      if (this._fired.has(i) || this.t < e.t) return;
      this._fired.add(i);
      const m = e.kind === 'crac_fan' ? this.setFan(e.target, e.value) : this.setPowerScale(e.target, e.value);
      if (m) out.push(m);
    });
  }

  controls() {
    const cfg = this.cfg;
    const power = {};
    for (const r of this.racks) {
      const wob = cfg.power_wobble * Math.sin((2 * Math.PI * this.t) / cfg.power_period_s + this.phase[r.name]);
      power[r.name] = Math.max(0.0, (this.basePower[r.name] + wob) * this.powerScale[r.name]);
    }
    return power;
  }

  // 시뮬레이션 1초를 진행하고 메시지 목록을 돌려준다.
  step() {
    const cfg = this.cfg;
    const out = [];
    this._applyEvents(out);
    const power = this.controls();
    const temps = this.solver.step(cfg.interval_s, this.fan, power);
    const ts = this.ts();
    let itPower = 0;
    let fanSum = 0;
    for (const s of this.sensors) {
      let v;
      if (s.metric === 'power' && s.equipmentType === 'rack') {
        v = Math.max(0, power[s.equipment] + normal(this.rand, cfg.noise_power));
        itPower += power[s.equipment];
      } else if (s.metric === 'fan_speed') {
        v = this.fan[s.equipment] * 100 + normal(this.rand, cfg.noise_fan);
        v = Math.min(Math.max(v, s.range[0]), s.range[1]);
        fanSum += this.fan[s.equipment];
      } else {
        const key = `${s.equipment}/${s.metric}`;
        if (!(key in temps)) continue;
        v = temps[key] + normal(this.rand, cfg.noise_temp);
      }
      v = Math.round(v * 1000) / 1000;
      const q = qualityFor(v, s.range);
      out.push({ kind: 'sample', sensorId: s.sensorId, value: v, quality: q, ts });
      const st = this.alarms.get(s.sensorId);
      if (q === 'good') {
        const tr = st.update(v);
        if (tr) out.push({ kind: 'alarm', sensorId: s.sensorId, from: tr[0], to: tr[1], value: v, ts, t: this.t });
      } else {
        st.breakRun();
      }
    }
    const cooling = coolingPower(cfg, this.cracs.length, this.racks.length, fanSum, itPower);
    const facility = itPower + cooling + itPower * cfg.loss_ratio;
    this.energyKwh += (facility * cfg.interval_s) / 3600;
    for (const [name, value] of [
      ['it_power', itPower],
      ['cooling_power', cooling],
      ['facility_power', facility],
      ['pue', itPower > 0 ? facility / itPower : 0],
      ['energy_kwh', this.energyKwh],
    ]) {
      out.push({ kind: 'aggregate', name, value: Math.round(value * 10000) / 10000, ts });
    }
    this.t += cfg.interval_s;
    return out;
  }
}
