// 브라우저 시뮬레이션 실행기 (docs/21). 엔진을 실제 시간에 맞춰 돌리고 저장소에 반영한다.
// 녹화 재생기(RecordingPlayer)와 같은 모양(playing, speed, time, duration, advance, seek)이라 화면의 재생 조작을 그대로 쓴다.
import { applyMessage } from '../apply.js';

const MAX_STEPS_PER_FRAME = 20; // 느린 기기나 탭 전환 뒤에 한꺼번에 몰아서 계산하지 않는다

export class SimRunner {
  constructor(engine, store, { onEvent = () => {} } = {}) {
    this.engine = engine;
    this.store = store;
    this.onEvent = onEvent;
    this.playing = true;
    this.speed = 1;
    this.loop = false;
    this.duration = null; // 끝이 없다
    this.log = []; // { t, text } 시나리오와 직접 조작 기록
    this._acc = 0;
  }

  get time() {
    return this.engine.t;
  }

  get scenario() {
    return this.engine.scenario;
  }

  _apply(msgs) {
    for (const m of msgs) {
      applyMessage(this.store, m);
      if (m.kind === 'scenario' && m.event === 'event' && m.info) this._record(m.info);
    }
  }

  _record(info) {
    const entry = { t: this.engine.t, ...info };
    this.log.push(entry);
    if (this.log.length > 100) this.log.shift();
    this.onEvent(entry);
  }

  // 시나리오를 처음부터 시작한다. 시작하자마자 첫 값이 보이도록 한 단계 진행한다.
  start(name) {
    this.store.clear();
    this.log = [];
    this._acc = 0;
    applyMessage(this.store, this.engine.startScenario(name));
    this._apply(this.engine.step());
  }

  // 지난 실제 시간(초)만큼 진행한다. 반환: 진행한 단계 수
  advance(elapsedSec) {
    if (!this.playing) return 0;
    this._acc += Math.min(Math.max(elapsedSec, 0), 1) * this.speed;
    const n = Math.min(Math.floor(this._acc), MAX_STEPS_PER_FRAME);
    this._acc -= Math.floor(this._acc);
    for (let i = 0; i < n; i++) this._apply(this.engine.step());
    return n;
  }

  seek() {
    /* 시뮬레이션은 앞으로만 간다 */
  }

  setFan(crac, ratio) {
    const m = this.engine.setFan(crac, ratio);
    if (m) this._apply([m]);
    return !!m;
  }

  setPowerScale(target, scale) {
    const m = this.engine.setPowerScale(target, scale);
    if (m) this._apply([m]);
    return !!m;
  }
}

// 기록을 사람이 읽는 문장으로
export function describeControl(info, prettyName) {
  const pct = `${Math.round(info.value * 100)}%`;
  if (info.kind === 'crac_fan') return `${prettyName(info.target)} 팬 → ${pct}`;
  const target = info.target.startsWith('row:') ? `${Number(info.target.slice(4))}번 줄` : prettyName(info.target);
  return `${target} 전력 → ${pct}`;
}
