// 데이터 출처 어댑터. 센서 값이 어디서 오는지(녹화, 브라우저 시뮬레이션, 라이브나 로컬 서버)를 같은 모양으로 감싼다.
// 화면과 3D를 모른다(DOM 없음). 화면은 describe()가 돌려주는 값만 읽는다.
//
// 모든 출처가 가진 것:
//   kind      'rec'(모니터링 기록) | 'lib'(미리 계산한 상태와 시나리오 모음) | 'sim'(브라우저 간이 계산) | 'live'(라이브, 로컬 서버)
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

// ---- 녹화(모니터링 기록)와 라이브러리(미리 계산한 상태와 시나리오 모음) ----
// 둘은 같은 재생 방식이고 목록과 표시만 다르다. alias 항목(file)은 다른 항목의 녹화 파일을 쓴다.
export class RecSource {
  // opts: { store, sensorIds, index(목록), loadJson(file) -> 녹화 JSON, cache(여러 출처가 같은 파일을 한 번만 받게 공유), kind, badgeText, groups }
  constructor({ store, sensorIds, index, loadJson, cache = new Map(), kind = 'rec', badgeText = '녹화 재생 · 실시간 아님', groups = null }) {
    this.kind = kind;
    this.badgeText = badgeText;
    this.groups = groups;
    this.control = false;
    this.store = store;
    this.sensorIds = sensorIds;
    this.index = index;
    this.loadJson = loadJson;
    this.cache = cache;
    this.player = null;
    this.scenarioId = null;
    this._clock = new SecondClock();
  }

  async _load(id) {
    const file = this.index.find((x) => x.id === id)?.file ?? id; // alias는 가리키는 녹화를 쓴다
    if (!this.cache.has(file)) this.cache.set(file, parseRecording(await this.loadJson(file), this.sensorIds));
    return this.cache.get(file);
  }

  // args: { scenarioId, t } 같은 출처 안에서 시나리오를 바꾸면 재생 설정(반복, 속도, 일시정지)을 이어 간다
  async open({ scenarioId, t = 0 }) {
    const mine = (this._openSeq = (this._openSeq ?? 0) + 1);
    const rec = await this._load(scenarioId);
    if (mine !== this._openSeq) return; // 그 사이 다른 시나리오를 열었다: 늦게 끝난 쪽이 덮어쓰지 않는다
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
      kind: this.kind,
      control: false,
      // 항목의 출처가 외부 솔버면 우리 모델이 만든 값이 아니므로 표시를 바꾼다(잘못된 출처 표시를 막는다)
      badge: { mode: this.kind, text: meta?.source === 'external' ? `외부 솔버 결과${meta.tool ? ` (${meta.tool})` : ''} · 이 컴퓨터의 서버만 줌` : this.badgeText },
      panel: 'none',
      scenarios: { list: this.index, current: this.scenarioId, groups: this.groups },
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

  // seed가 있으면 모니터링의 지금 값에서 시작한다(docs/31). 없으면 시나리오를 처음부터.
  open({ scenarioId = 'normal', seed = null } = {}) {
    if (!this.scenarios[scenarioId]) scenarioId = 'normal';
    this.scenarioId = scenarioId;
    this.seeded = !!seed;
    if (!this.runner) {
      const engine = this.makeEngine();
      this.runner = new SimRunner(engine, this.store, { onEvent: (e) => this.onEvent(e, engine) });
    }
    if (seed) this.runner.startFrom(seed);
    else this.runner.start(scenarioId); // 엔진은 한 번만 만들고 다시 쓴다(조작 상태는 start가 되돌린다)
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
      badge: { mode: 'sim', text: this.seeded ? '간이 계산 · 모니터링 지금 값에서 시작(브라우저 간이 모델)' : '간이 계산 · 브라우저 간이 모델' },
      panel: 'sim',
      scenarios: { list: this.list, current: this.seeded ? null : this.scenarioId },
      card: this.seeded
        ? { title: '모니터링 지금 값에서 시작', desc: '모니터링에서 보던 온도, 팬, 급기 값에서 시작했다. 조작 탭에서 팬 속도와 급기 온도를 바꾸면 바로 다시 계산하고, 에너지·용량 탭의 "기준과 비교"에 바뀌기 전과 차이가 보인다. 빠른 간이 모델이라 정확한 값은 시뮬레이션 메뉴의 서버 계산을 쓴다.', events: [], seekable: false }
        : { title: s.title, desc: s.description, events: s.events, seekable: false },
      timebar: null,
    };
  }
}

// ---- 라이브(게이트웨이)와 로컬 서버(조작을 보냄) ----
const STATE_TEXT = (label) => ({ connecting: `${label} 연결 중`, open: `${label} 연결됨`, idle: `${label} 중지` });

export class LiveSource {
  // opts: { store, url, control, token(접근 토큰, 선택), simList, current(시나리오), onChange(), makeClient(url, store, handlers) }
  constructor({ store, url, control = false, token = null, simList = [], current = 'normal', onChange = () => {}, makeClient = (u, s, h) => new LiveClient(u, s, h) }) {
    this.kind = 'live';
    this.control = control;
    this.store = store;
    this.url = url;
    this.token = token;
    this.simList = simList;
    this.current = current;
    this.onChange = onChange;
    this.makeClient = makeClient;
    this.client = null;
    this.player = null;
  }

  get label() {
    return this.control ? '실시간 · 로컬 서버' : '라이브';
  }

  open() {
    this.client = this.makeClient(this.url, this.store, { onState: () => this.onChange(), token: this.token });
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
    if (s === 'denied') return { mode: 'closed', text: c.denied === 'wrong' ? '접근 토큰이 맞지 않다. 서버 연결 창에서 토큰을 다시 넣는다' : '서버가 접근 토큰을 요구한다. 서버 연결 창에서 토큰을 넣는다' };
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
        desc: this.control
          ? '모니터링: 서버(Omniverse Kit 안의 센서 생성기)가 현장 역할을 하며 장비 상태에 따라 실제 시간으로 만든 값이다. 물리 센서는 없다. 시나리오와 장비 조작은 서버로 전달된다.'
          : '게이트웨이가 보내는 센서 값을 그대로 보여 준다.',
        events: [],
        seekable: false,
      },
      timebar: null,
    };
  }
}

// 미리 계산한 상태와 시나리오 모음(Warp 열 시뮬레이션 + 보정 모델로 계산해 둔 값). 서버 없이 보이는 "시뮬레이션" 메뉴의 기본이다.
export class LibSource extends RecSource {
  constructor(opts) {
    super({ kind: 'lib', badgeText: '미리 계산한 값 · Warp 열 시뮬레이션 + 보정 모델', ...opts });
  }
}
