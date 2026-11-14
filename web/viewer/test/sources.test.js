import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LibSource, LiveSource, RecSource, SimSource } from '../src/sources.js';
import { SCENARIOS } from '../src/sim/core.js';
import { layoutFrom, SimEngine } from '../src/sim/engine.js';
import { SensorStore } from '../src/store.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const sensors = read('../public/data/sensors.json');
const scene = read('../public/data/scene.json');
const index = read('../public/data/index.json');
const layout = layoutFrom(scene.racks, sensors);
const ids = sensors.map((s) => s.sensorId);

const mkRec = (store = new SensorStore(sensors)) => new RecSource({ store, sensorIds: ids, index, loadJson: async (id) => read(`../public/data/rec/${id}.json`) });
const mkSim = (store = new SensorStore(sensors), extra = {}) => {
  let made = 0;
  const src = new SimSource({ store, makeEngine: () => (made++, new SimEngine({ sensors, ...layout, seed: 7 })), scenarios: SCENARIOS, ...extra });
  return { src, made: () => made, store };
};

describe('RecSource', () => {
  it('열면 재생기가 생기고 설명이 시나리오와 시간 막대를 담는다', async () => {
    const s = mkRec();
    await s.open({ scenarioId: 'fan_fault', t: 100 });
    expect(s.kind).toBe('rec');
    expect(s.player.time).toBe(100);
    const d = s.describe();
    expect(d.badge.mode).toBe('rec');
    expect(d.panel).toBe('none');
    expect(d.scenarios.current).toBe('fan_fault');
    expect(d.card.seekable).toBe(true);
    expect(d.timebar.n).toBe(300);
  });
  it('advance는 처음과 정수 초가 바뀔 때만 true', async () => {
    const s = mkRec();
    await s.open({ scenarioId: 'normal' });
    expect(s.advance(0.1)).toBe(true); // 처음 한 번
    expect(s.advance(0.1)).toBe(false);
    expect(s.advance(0.5)).toBe(false);
    expect(s.advance(0.5)).toBe(true); // 1초를 넘음
  });
  it('같은 출처 안에서 시나리오를 바꾸면 반복, 속도, 일시정지를 이어 가고 다른 출처를 거치면 새로 시작', async () => {
    const s = mkRec();
    await s.open({ scenarioId: 'normal' });
    s.player.loop = false;
    s.player.speed = 5;
    s.player.playing = false;
    await s.open({ scenarioId: 'power_spike' });
    expect(s.player).toMatchObject({ loop: false, speed: 5, playing: false });
    s.close();
    await s.open({ scenarioId: 'normal' });
    expect(s.player).toMatchObject({ loop: true, speed: 1, playing: true });
  });
  it('녹화가 깨져 있으면 열기가 오류를 던지고 이전 재생기는 그대로', async () => {
    const s = new RecSource({ store: new SensorStore(sensors), sensorIds: ids, index, loadJson: async () => ({ version: 9 }) });
    await expect(s.open({ scenarioId: 'normal' })).rejects.toThrow('지원하지 않는 녹화 버전');
    expect(s.player).toBeNull();
  });
});

describe('SimSource', () => {
  it('열면 시나리오가 시작되고 첫 값이 저장소에 있다', () => {
    const { src, store } = mkSim();
    src.open({ scenarioId: 'fan_fault' });
    expect(src.kind).toBe('sim');
    expect(src.player).toBe(src.runner);
    expect(store.aggregates.it_power).toBeGreaterThan(0);
    const d = src.describe();
    expect(d).toMatchObject({ panel: 'sim', badge: { mode: 'sim' } });
    expect(d.scenarios.list.map((x) => x.id).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(d.card.seekable).toBe(false);
  });
  it('seed를 주면 모니터링 지금 값에서 시작하고 표시가 바뀐다(시나리오 선택 없음)', () => {
    const { src } = mkSim();
    src.open({ scenarioId: 'normal', seed: { supply: 22 } });
    expect(src.engine.scenario).toBe('monitor');
    expect(src.engine.cfg.t_supply).toBe(22);
    const d = src.describe();
    expect(d.badge.text).toContain('모니터링 지금 값에서 시작');
    expect(d.scenarios.current).toBeNull();
    src.open({ scenarioId: 'fan_fault' }); // seed 없이 다시 열면 시나리오로 돌아간다
    expect(src.describe().badge.text).toBe('간이 계산 · 브라우저 간이 모델');
  });
  it('엔진은 한 번만 만들고 다시 열면 같은 엔진으로 처음부터 시작', () => {
    const { src, made } = mkSim();
    src.open({ scenarioId: 'normal' });
    const engine = src.engine;
    for (let i = 0; i < 5; i++) src.advance(1);
    src.open({ scenarioId: 'cooling_failure' });
    expect(made()).toBe(1);
    expect(src.engine).toBe(engine);
    expect(src.engine.t).toBeLessThan(3); // 시간이 처음으로 돌아감
  });
  it('모르는 시나리오 이름은 normal로', () => {
    const { src } = mkSim();
    src.open({ scenarioId: '없는것' });
    expect(src.scenarioId).toBe('normal');
  });
  it('advance는 1초가 지날 때 true', () => {
    const { src } = mkSim();
    src.open({ scenarioId: 'normal' });
    expect(src.advance(0.2)).toBe(true); // 열자마자 한 번
    expect(src.advance(0.2)).toBe(false);
    expect(src.advance(1)).toBe(true);
  });
});

const fakeClient = (over = {}) => {
  const c = { state: 'connecting', lastMessageAt: null, lastError: null, dropped: 0, retryInMs: 0, started: false, stopped: false, sent: [], flushed: false, ...over };
  c.start = () => (c.started = true);
  c.stop = () => (c.stopped = true);
  c.flush = () => c.flushed;
  c.send = (o) => (c.state === 'open' ? (c.sent.push(o), true) : false);
  return c;
};

describe('LiveSource', () => {
  it('열면 클라이언트를 시작하고 닫으면 멈춘다', () => {
    let client;
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'ws://x/ws', makeClient: () => (client = fakeClient()) });
    s.open();
    expect(client.started).toBe(true);
    s.close();
    expect(client.stopped).toBe(true);
    expect(s.client).toBeNull();
  });
  it('연결 상태에 따라 모드 표시와 문구가 바뀐다', () => {
    let client;
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'ws://127.0.0.1:8765/ws', control: true, makeClient: () => (client = fakeClient()) });
    s.open();
    expect(s.describe().badge).toEqual({ mode: 'connecting', text: '실시간 · 로컬 서버 연결 중' });
    client.state = 'open';
    expect(s.describe().badge).toEqual({ mode: 'open', text: '실시간 · 로컬 서버 연결됨' });
    client.state = 'closed';
    client.retryInMs = 4000;
    expect(s.describe().badge).toEqual({ mode: 'closed', text: '연결 끊김, 4초 뒤 다시 시도' });
  });
  it('이 컴퓨터 밖의 서버는 "원격 서버(주소)"로 표시한다(docs/30 M6)', () => {
    const mk = (url) => new LiveSource({ store: new SensorStore(sensors), url, control: true, makeClient: () => fakeClient() });
    expect(mk('wss://dc.example.org:9000/ws').label).toBe('실시간 · 원격 서버(dc.example.org:9000)');
    expect(mk('ws://localhost:8765/ws').label).toBe('실시간 · 로컬 서버');
    expect(mk('u').label).toBe('실시간 · 원격 서버');
  });
  it('로컬 서버는 조작 패널과 시나리오 목록을 갖고 일반 라이브는 갖지 않는다', () => {
    const list = [{ id: 'normal', title: '정상', note: '' }];
    const a = new LiveSource({ store: new SensorStore(sensors), url: 'u', control: true, simList: list, current: 'normal', makeClient: () => fakeClient() });
    const b = new LiveSource({ store: new SensorStore(sensors), url: 'u', makeClient: () => fakeClient() });
    expect(a.describe()).toMatchObject({ panel: 'server', scenarios: { list, current: 'normal' } });
    expect(b.describe()).toMatchObject({ panel: 'none', scenarios: null });
    expect(b.player).toBeNull();
  });
  it('조작은 연결되어 있을 때만 보내진다', () => {
    let client;
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'u', control: true, makeClient: () => (client = fakeClient()) });
    expect(s.send({ kind: 'scenario', name: 'normal' })).toBe(false); // 열기 전
    s.open();
    expect(s.send({ kind: 'scenario', name: 'normal' })).toBe(false); // 연결 중
    client.state = 'open';
    expect(s.send({ kind: 'crac_fan', target: 'crac_01', value: 0.5 })).toBe(true);
    expect(client.sent[0]).toEqual({ type: 'control', kind: 'crac_fan', target: 'crac_01', value: 0.5 });
  });
  it('상태 줄은 열렸을 때만 나오고 거절 이유를 6초 동안 붙인다', () => {
    let client;
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'ws://h/ws', makeClient: () => (client = fakeClient()) });
    s.open();
    expect(s.statusText(10000)).toBeNull();
    client.state = 'open';
    client.lastMessageAt = 7000;
    client.dropped = 2;
    expect(s.statusText(10000)).toBe('ws://h/ws  마지막 수신 3초 전, 버린 메시지 2건');
    client.lastError = { at: 9000, message: '범위 밖' };
    expect(s.statusText(10000)).toContain('서버가 거절함: 범위 밖');
    expect(s.statusText(20000)).not.toContain('거절');
  });
  it('advance는 클라이언트가 넘겨준 값이 있을 때 true', () => {
    let client;
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'u', makeClient: () => (client = fakeClient()) });
    expect(s.advance()).toBe(false);
    s.open();
    expect(s.advance()).toBe(false);
    client.flushed = true;
    expect(s.advance()).toBe(true);
  });
});

describe('LibSource(미리 계산한 값)', () => {
  const mk = (cache) => {
    const loaded = [];
    const src = new LibSource({ store: new SensorStore(sensors), sensorIds: ids, index, cache, loadJson: async (file) => (loaded.push(file), read(`../public/data/rec/${file}.json`)), groups: [{ id: 'event', title: '이상 상황' }] });
    return { src, loaded };
  };
  it('모든 항목을 목록에 담고 모드 표시는 lib다', async () => {
    const { src } = mk();
    await src.open({ scenarioId: 'supply_24' });
    const d = src.describe();
    expect(d.kind).toBe('lib');
    expect(d.badge.mode).toBe('lib');
    expect(d.scenarios.list.length).toBe(index.length);
    expect(d.scenarios.groups).toEqual([{ id: 'event', title: '이상 상황' }]);
    expect(d.card.seekable).toBe(true);
  });
  it('표시 뒤에 붙일 말(격벽 방식)은 지금 항목의 녹화 파일로 정한다(alias는 가리키는 파일, docs/34 6장)', async () => {
    const asked = [];
    const src = new LibSource({ store: new SensorStore(sensors), sensorIds: ids, index, loadJson: async (file) => read(`../public/data/rec/${file}.json`), badgeSuffix: (file) => (asked.push(file), ' · CAC 계산') });
    await src.open({ scenarioId: 'supply_18' });
    expect(src.fileOf('supply_18')).toBe('normal');
    expect(src.describe().badge.text).toBe('미리 계산한 값 · Warp 열 시뮬레이션 + 보정 모델 · CAC 계산');
    expect(asked.at(-1)).toBe('normal');
    const plain = new LibSource({ store: new SensorStore(sensors), sensorIds: ids, index, loadJson: async (file) => read(`../public/data/rec/${file}.json`) });
    await plain.open({ scenarioId: 'normal' });
    expect(plain.describe().badge.text).toBe('미리 계산한 값 · Warp 열 시뮬레이션 + 보정 모델');
  });
  it('alias 항목(급기 18도)은 가리키는 녹화 파일을 받고 같은 파일은 한 번만 받는다', async () => {
    const { src, loaded } = mk(new Map());
    await src.open({ scenarioId: 'supply_18' });
    await src.open({ scenarioId: 'load_100' });
    await src.open({ scenarioId: 'normal' });
    expect(loaded).toEqual(['normal']); // 세 항목이 같은 녹화
    expect(src.scenarioId).toBe('normal');
  });
  it('급기 온도가 높은 항목일수록 냉각 전력이 낮다(녹화 값)', async () => {
    const { src } = mk();
    const cool = [];
    for (const id of ['supply_16', 'supply_18', 'supply_20', 'supply_22', 'supply_24']) {
      await src.open({ scenarioId: id, t: 200 });
      cool.push(src.store.aggregates.cooling_power);
    }
    expect(cool.every((v, i) => i === 0 || v < cool[i - 1])).toBe(true);
  });
  it('외부 솔버 결과 항목은 우리 모델의 값이 아니라고 표시한다', async () => {
    const ext = { ...index.find((i) => i.id === 'normal'), id: 'ext_demo', group: 'external', source: 'external', tool: '합성 시험 데이터' };
    const src = new LibSource({ store: new SensorStore(sensors), sensorIds: ids, index: [...index, ext], loadJson: async () => read('../public/data/rec/normal.json') });
    await src.open({ scenarioId: 'ext_demo' });
    expect(src.describe().badge.text).toBe('외부 솔버 결과 (합성 시험 데이터) · 이 컴퓨터의 서버만 줌');
    await src.open({ scenarioId: 'normal' });
    expect(src.describe().badge.text).toMatch(/Warp 열 시뮬레이션/);
  });
  it('모니터링(RecSource)과 같은 캐시를 쓰면 같은 녹화를 다시 받지 않는다', async () => {
    const cache = new Map();
    const loaded = [];
    const loadJson = async (f) => (loaded.push(f), read(`../public/data/rec/${f}.json`));
    const store = new SensorStore(sensors);
    const rec = new RecSource({ store, sensorIds: ids, index: index.filter((i) => i.group === 'event'), loadJson, cache });
    const lib = new LibSource({ store, sensorIds: ids, index, loadJson, cache });
    await rec.open({ scenarioId: 'fan_fault' });
    await lib.open({ scenarioId: 'fan_fault' });
    expect(loaded).toEqual(['fan_fault']);
    expect(rec.describe().scenarios.list.every((i) => i.group === 'event')).toBe(true);
  });
});

describe('LiveSource 접근 토큰', () => {
  it('토큰을 클라이언트에 넘기고, 인증이 거절되면 이유를 표시한다', () => {
    let handlers;
    const client = fakeClient();
    const s = new LiveSource({ store: new SensorStore(sensors), url: 'wss://x/ws', control: true, token: 'tok-123456789012345', makeClient: (u, st, h) => ((handlers = h), client) });
    s.open();
    expect(handlers.token).toBe('tok-123456789012345');
    client.state = 'denied';
    client.denied = 'wrong';
    expect(s.describe().badge).toEqual({ mode: 'closed', text: '접근 토큰이 맞지 않다. 서버 연결 창에서 토큰을 다시 넣는다' });
    client.denied = 'missing';
    expect(s.describe().badge.text).toMatch(/토큰을 요구한다/);
  });
});

describe('RecSource 연속 전환 경쟁', () => {
  it('느린 시나리오가 나중에 끝나도 마지막으로 연 시나리오가 이긴다', async () => {
    const gates = {};
    const loadJson = (file) => new Promise((resolve) => (gates[file] = () => resolve(read(`../public/data/rec/${file}.json`))));
    const s = new RecSource({ store: new SensorStore(sensors), sensorIds: ids, index, loadJson });
    const slow = s.open({ scenarioId: 'fan_fault' }); // 먼저 눌렀지만 늦게 끝난다
    const fast = s.open({ scenarioId: 'normal' });
    gates.normal();
    await fast;
    expect(s.scenarioId).toBe('normal');
    gates.fan_fault();
    await slow; // 늦게 도착해도
    expect(s.scenarioId).toBe('normal'); // 덮어쓰지 않는다
    expect(s.player.rec.scenario).toBe('normal');
  });
});
