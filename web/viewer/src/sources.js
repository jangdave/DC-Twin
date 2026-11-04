// 데이터 출처 어댑터. 센서 값이 어디서 오는지(녹화, 브라우저 시뮬레이션, 라이브나 로컬 서버)를 같은 모양으로 감싼다.
// 화면과 3D를 모른다(DOM 없음). 화면은 describe()가 돌려주는 값만 읽는다.
//
// 모든 출처가 가진 것:
//   kind      'rec' | 'sim' | 'live'
//   control   서버에 조작을 보내는가(로컬 서버)
//   player    재생 막대가 다루는 객체(time, duration, playing, speed, loop, seek) 또는 null
//   open(args)  시작(비동기일 수 있음)      close()  멈춤
//   advance(dt) 지난 시간만큼 진행하고, 화면을 다시 그려야 하면 true
//   describe()  화면에 보일 값 { badge:{mode,text}, panel, scenarios, card, timebar }
//   statusText() 연결 상태 줄(없으면 null)    send(c) 서버 조작(서버일 때만)
import { LiveClient } from './live.js';
import { RecordingPlayer, parseRecording } from './recording.js';
import { SimRunner } from './sim/runner.js';

// 재생기와 같은 모양의 객체를 초 단위로 진행하고, 정수 초가 바뀌었거나 처음이면 true
class SecondClock {
  constructor() {
    this.reset();
  }

  reset() {
    this._sec = -1;
  }

  step(player, dt) {
    if (!player) return false;
    const before = Math.floor(player.time);
    player.advance(dt);
    const now = Math.floor(player.time);
    if (now !== before || this._sec < 0) {
      this._sec = now;
      return true;
    }
    return false;
  }
}

// ---- 녹화 ----
export class RecSource {
  // opts: { store, sensorIds, index(시나리오 목록), loadJson(id) -> 녹화 JSON }
  constructor({ store, sensorIds, index, loadJson }) {
    this.kind = 'rec';
    this.control = false;
    this.store = store;
    this.sensorIds = sensorIds;
    this.index = index;
    this.loadJson = loadJson;
    this.cache = new Map();
    this.player = null;
    this.scenarioId = null;
    this._clock = new SecondClock();
  }

  async _load(id) {
    if (!this.cache.has(id)) this.cache.set(id, parseRecording(await this.loadJson(id), this.sensorIds));
    return this.cache.get(id);
  }

  // args: { scenarioId, t } 같은 출처 안에서 시나리오를 바꾸면 재생 설정(반복, 속도, 일시정지)을 이어 간다
  async open({ scenarioId, t = 0 }) {
    const rec = await this._load(scenarioId);
    const old = this.player;
    this.scenarioId = scenarioId;
    this.player = new RecordingPlayer(rec, this.store, { loop: old?.loop ?? true, speed: old?.speed ?? 1 });
    this.player.playing = old?.playing ?? true;
    this.player.seek(t);
    this._clock.reset();
  }

  // 다른 출처로 갔다 오면 재생 설정은 새로 시작한다
  close() {
    this.player = null;
  }

  advance(dt) {
    return this._clock.step(this.player, dt);
  }

  statusText() {
    return null;
  }

  describe() {
    const rec = this.player?.rec;
    const meta = this.index.find((x) => x.id === this.scenarioId);
    return {
      kind: 'rec',
      control: false,
      badge: { mode: 'rec', text: '녹화 재생 · 실시간 아님' },
      panel: 'none',
      scenarios: { list: this.index, current: this.scenarioId },
      card: { title: meta?.title ?? this.scenarioId, desc: meta?.note ?? '', events: rec?.events ?? [], seekable: true },
      timebar: rec ? { n: rec.n, events: rec.events } : null,
    };
  }
}

// ---- 브라우저 시뮬레이션 ----
export class SimSource {
  // opts: { store, makeEngine() -> SimEngine, scenarios: { id: { title, description, events } }, onEvent(entry) }
  constructor({ store, makeEngine, scenarios, onEvent = () => {} }) {
    this.kind = 'sim';
    this.control = false;
    this.store = store;
    this.makeEngine = makeEngine;
    this.scenarios = scenarios;
    this.onEvent = onEvent;
    this.runner = null;
    this.scenarioId = 'normal';
    this._clock = new SecondClock();
    this.list = Object.entries(scenarios).map(([id, s]) => ({ id, title: s.title, note: s.description }));
  }

  get player() {
    return this.runner;
  }

  get engine() {
    return this.runner?.engine ?? null;
  }

  open({ scenarioId = 'normal' } = {}) {
    if (!this.scenarios[scenarioId]) scenarioId = 'normal';
    this.scenarioId = scenarioId;
    if (!this.runner) {
      const engine = this.makeEngine();
      this.runner = new SimRunner(engine, this.store, { onEvent: (e) => this.onEvent(e, engine) });
    }
    this.runner.start(scenarioId); // 엔진은 한 번만 만들고 다시 쓴다(조작 상태는 start가 되돌린다)
    this._clock.reset();
  }

  close() {}

  advance(dt) {
    return this._clock.step(this.runner, dt);
  }

  statusText() {
    return null;
  }

  describe() {
    const s = this.scenarios[this.scenarioId];
    return {
      kind: 'sim',
      control: false,
      badge: { mode: 'sim', text: '직접 시뮬레이션 · 간이 모델' },
      panel: 'sim',
      scenarios: { list: this.list, current: this.scenarioId },
      card: { title: s.title, desc: s.description, events: s.events, seekable: false },
      timebar: null,
    };
  }
}

// ---- 라이브(게이트웨이)와 로컬 서버(조작을 보냄) ----
const STATE_TEXT = (label) => ({ connecting: `${label} 연결 중`, open: `${label} 연결됨`, idle: `${label} 중지` });

export class LiveSource {
  // opts: { store, url, control, simList, current(시나리오), onChange(), makeClient(url, store, handlers) }
  constructor({ store, url, control = false, simList = [], current = 'normal', onChange = () => {}, makeClient = (u, s, h) => new LiveClient(u, s, h) }) {
    this.kind = 'live';
    this.control = control;
    this.store = store;
    this.url = url;
    this.simList = simList;
    this.current = current;
    this.onChange = onChange;
    this.makeClient = makeClient;
    this.client = null;
    this.player = null;
  }

  get label() {
    return this.control ? '로컬 서버' : '라이브';
  }

  open() {
    this.client = this.makeClient(this.url, this.store, { onState: () => this.onChange() });
    this.client.start();
  }

  close() {
    this.client?.stop();
    this.client = null;
  }

  advance() {
    return this.client ? !!this.client.flush() : false;
  }

  send(c) {
    return !!this.client?.send({ type: 'control', ...c });
  }

  // 열려 있을 때만 "마지막 수신" 줄을 돌려준다
  statusText(now = Date.now()) {
    const c = this.client;
    if (!c || c.state !== 'open') return null;
    const age = c.lastMessageAt ? Math.round((now - c.lastMessageAt) / 1000) : null;
    const err = c.lastError && now - c.lastError.at < 6000 ? ` / 서버가 거절함: ${c.lastError.message}` : '';
    return `${this.url}  마지막 수신 ${age === null ? '–' : `${age}초 전`}, 버린 메시지 ${c.dropped}건${err}`;
  }

  stateBadge() {
    const c = this.client;
    const s = c?.state ?? 'connecting';
    const text = s === 'closed' ? `연결 끊김, ${Math.round((c.retryInMs ?? 0) / 1000)}초 뒤 다시 시도` : STATE_TEXT(this.label)[s] ?? `${this.label} 연결 중`;
    return { mode: s === 'open' ? 'open' : s === 'closed' ? 'closed' : 'connecting', text };
  }

  describe() {
    return {
      kind: 'live',
      control: this.control,
      badge: this.stateBadge(),
      panel: this.control ? 'server' : 'none',
      scenarios: this.control ? { list: this.simList, current: this.current } : null,
      card: {
        title: this.label,
        desc: this.control ? '이 컴퓨터의 계산 서버가 실제 시간으로 계산한 값을 보여 준다. 시나리오와 조작은 서버로 전달된다.' : '게이트웨이가 보내는 센서 값을 그대로 보여 준다.',
        events: [],
        seekable: false,
      },
      timebar: null,
    };
  }
}
