// 화면 단계와 화면 이동 명령 (docs/20 2~3장). 화면과 무관한 순수 로직이다.
import { countActiveAlarms } from './store.js';

// 명령 번호는 한 번 정하면 바꾸지 않는다(새로 추가만). Unreal과 같은 표를 쓴다.
export const COMMANDS = {
  'view.goto': 10001,
  'view.back': 10002,
  'view.select': 10003,
  'view.layer': 10004,
  'sim.scenario': 10005,
};

export const STAGES = ['exterior', 'hall']; // 웹은 둘러보기(walk)가 없다(docs/20 2장 S4)
const LAYERS = ['temp', 'power'];

// 화면 단계. exterior <-> hall만 오간다.
export class FlowState {
  constructor(stage = 'exterior') {
    this.stage = STAGES.includes(stage) ? stage : 'exterior';
  }
  goto(stage) {
    if (!STAGES.includes(stage) || stage === this.stage) return false;
    this.stage = stage;
    return true;
  }
  back() {
    if (this.stage === 'hall') {
      this.stage = 'exterior';
      return true;
    }
    return false;
  }
}

// 명령을 검사한다. 맞으면 { name, value }, 아니면 null
export function parseCommand(cmd) {
  if (!cmd || typeof cmd.name !== 'string' || !(cmd.name in COMMANDS)) return null;
  const v = cmd.value;
  switch (cmd.name) {
    case 'view.goto':
      return STAGES.includes(v) ? { name: cmd.name, value: v } : null;
    case 'view.back':
      return { name: cmd.name, value: null };
    case 'view.select':
      return v === null || v === undefined || v === '' ? { name: cmd.name, value: null } : typeof v === 'string' && /^(rack|crac)_\d+$/.test(v) ? { name: cmd.name, value: v } : null;
    case 'view.layer':
      return LAYERS.includes(v) ? { name: cmd.name, value: v } : null;
    case 'sim.scenario':
      return typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? { name: cmd.name, value: v } : null;
  }
  return null;
}

// 준비 전 명령은 쌓았다가 준비되면 순서대로 실행한다. 같은 이름이 여럿 쌓였으면 마지막 것만 실행한다.
export class CommandQueue {
  constructor(execute) {
    this.execute = execute;
    this.ready = false;
    this.pending = [];
    this.rejected = 0; // 알 수 없거나 값이 틀려 버린 명령 수
  }
  push(cmd) {
    const c = parseCommand(cmd);
    if (!c) {
      this.rejected++;
      return false;
    }
    if (!this.ready) {
      this.pending = this.pending.filter((p) => p.name !== c.name);
      this.pending.push(c);
      return true;
    }
    this.execute(c);
    return true;
  }
  setReady() {
    this.ready = true;
    const list = this.pending;
    this.pending = [];
    for (const c of list) this.execute(c);
  }
}

// 외관 화면에 보일 건물 요약. 값이 없으면 null로 둔다.
export function summarize(store, rackKeys) {
  const alarms = countActiveAlarms(store.latest);
  let maxIn = null;
  let maxRack = null;
  for (const k of rackKeys) {
    const m = store.metric(k, 'temp_in');
    if (m && Number.isFinite(m.value) && (maxIn === null || m.value > maxIn)) {
      maxIn = m.value;
      maxRack = k;
    }
  }
  const a = store.aggregates ?? {};
  return {
    hasData: store.latest.size > 0,
    alarms,
    maxTempIn: maxIn,
    maxRack,
    itPower: Number.isFinite(a.it_power) ? a.it_power : null,
    facilityPower: Number.isFinite(a.facility_power) ? a.facility_power : null, // 건물 전체 = 설비 전력(IT + 냉각 + 손실). 에너지 탭과 같은 값
    kwh: Number.isFinite(a.energy_kwh) ? a.energy_kwh : null, // 지금까지 쓴 전력량
    pue: Number.isFinite(a.pue) ? a.pue : null,
  };
}
