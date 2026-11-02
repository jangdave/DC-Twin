// 시작과 화면 조립 (docs/18 8.1장). 입력(녹화 또는 라이브)은 같은 저장소를 갱신하고 화면은 저장소만 읽는다.
import { CommandQueue, FlowState, summarize } from './flow.js';
import { HallScene, VIEWS } from './scene.js';
import { LiveClient } from './live.js';
import { parseRecording, RecordingPlayer } from './recording.js';
import { SensorStore } from './store.js';
import { SCENARIOS } from './sim/core.js';
import { SimEngine, layoutFrom } from './sim/engine.js';
import { SimPanel } from './sim/panel.js';
import { SimRunner } from './sim/runner.js';
import { UI, prettyName, METRIC_LABEL } from './ui.js';
import { parseParams } from './url.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

async function main() {
  const badge = $('mode-badge');
  if (!webglOk()) {
    $('webgl-error').hidden = false;
    badge.textContent = 'WebGL 없음';
    return;
  }
  let sensors;
  let sceneData;
  let index;
  try {
    [sensors, sceneData, index] = await Promise.all([getJson('data/sensors.json'), getJson('data/scene.json'), getJson('data/index.json')]);
  } catch (e) {
    badge.textContent = '자료를 못 받음';
    console.error(e);
    return;
  }

  const ids = index.map((s) => s.id);
  const params = parseParams(location.search, ids);
  const store = new SensorStore(sensors);
  const sensorInfo = store.byId;
  const flow = new FlowState(params.stage ?? 'exterior');
  const rackKeys = sceneData.racks.map((r) => r.name.toLowerCase());
  const scene = new HallScene($('canvas'), $('labels'), sceneData, store, { reducedMotion, stage: flow.stage });

  const state = {
    mode: 'rec', // rec | sim | live
    sim: null,
    simScenario: params.scenario ?? 'normal',
    scenarioId: params.scenario ?? 'normal',
    player: null,
    live: null,
    view: params.view ?? 'temp_in',
    selected: null,
    recCache: new Map(),
    lastSec: -1,
    stage: flow.stage,
  };

  const ui = new UI(store, {
    onSelect: (eq, focus) => selectEquipment(eq, focus),
    onView: (v) => setView(v),
    onScenario: (id) => (state.mode === 'sim' ? startSim(id) : loadScenario(id, 0)),
    onMode: (m) => (m === 'sim' ? startSim(state.simScenario) : startRecording()),
    onPlay: () => state.player && ((state.player.playing = !state.player.playing), ui.renderTransport(state.player)),
    onSpeed: (x) => state.player && ((state.player.speed = x), ui.renderTransport(state.player)),
    onSeek: (t) => state.player && (state.player.seek(t), refresh()),
    onLoop: (b) => state.player && (state.player.loop = b),
    onPreset: (p) => scene.setPreset(p),
    onLabels: (b) => scene.setLabels(b),
    onBackToRec: () => startRecording(),
    onEnter: () => queue.push({ name: 'view.goto', value: 'hall' }),
    onBack: () => queue.push({ name: 'view.back' }),
  });
  ui.setScenarios(index, state.scenarioId);

  // ---- 직접 시뮬레이션(브라우저 간이 모델, docs/21) ----
  const simRows = [...new Set(sceneData.racks.map((r) => r.row))].sort((a, b) => a - b);
  const simList = Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, note: s.description }));
  const panel = new SimPanel(
    {
      onFan: (c, v) => state.sim?.setFan(c, v),
      onPower: (t, v) => state.sim?.setPowerScale(t, v),
      onSelectedPower: (r, v) => state.sim?.setPowerScale(r, v),
      onReset: () => startSim(state.simScenario),
    },
    prettyName,
  );
  const layout = layoutFrom(sceneData.racks, sensors);
  panel.build(layout.cracs, simRows);

  function startSim(id = 'normal') {
    if (!SCENARIOS[id]) id = 'normal';
    if (state.live) {
      state.live.stop();
      state.live = null;
    }
    state.mode = 'sim';
    state.simScenario = id;
    if (!state.sim) {
      const engine = new SimEngine({ sensors, ...layout, seed: 7 });
      state.sim = new SimRunner(engine, store, { onEvent: () => panel.syncFromEngine(engine) });
    }
    state.player = state.sim;
    ui.setMode('sim', '직접 시뮬레이션 (이 브라우저의 간이 모델, 실제 계산이 아님)');
    ui.setScenarios(simList, id);
    panel.show(true);
    panel.setScenario(id);
    state.sim.start(id);
    panel.syncFromEngine(state.sim.engine);
    panel.setSelected(state.selected, state.sim.engine);
    ui.renderTransport(state.sim);
    state.lastSec = -1;
    refresh();
  }

  // ---- 화면 단계와 이동 명령 (docs/20) ----
  function applyStage(instant = false) {
    scene.setStage(flow.stage, instant);
    ui.setStage(flow.stage);
    state.stage = flow.stage;
    refresh();
  }

  function execute(c) {
    switch (c.name) {
      case 'view.goto':
        if (flow.goto(c.value)) applyStage();
        break;
      case 'view.back':
        if (flow.back()) applyStage();
        break;
      case 'view.select':
        if (c.value === null) {
          if (state.selected) selectEquipment(state.selected);
        } else if (state.selected !== c.value && (rackKeys.includes(c.value) || c.value.startsWith('crac_'))) {
          selectEquipment(c.value, flow.stage === 'hall');
        }
        break;
      case 'view.layer':
        setView(c.value === 'power' ? 'power' : 'temp_in');
        break;
      case 'sim.scenario':
        if (state.mode === 'rec' && ids.includes(c.value)) loadScenario(c.value, 0);
        else if (state.mode === 'sim' && SCENARIOS[c.value]) startSim(c.value);
        break;
    }
  }
  const queue = new CommandQueue(execute);

  function setView(v) {
    if (!VIEWS[v]) return;
    state.view = v;
    scene.setView(v);
    ui.renderLegend(v);
    document.querySelectorAll('input[name="view"]').forEach((r) => (r.checked = r.value === v));
    ui.renderDetail(v);
  }

  function selectEquipment(eq, focus = false) {
    state.selected = state.selected === eq && !focus ? null : eq;
    scene.select(state.selected);
    ui.setSelected(state.selected);
    if (state.mode === 'sim') panel.setSelected(state.selected, state.sim.engine);
    ui.renderDetail(state.view);
    if (state.selected && focus) scene.focus(state.selected);
  }

  async function loadRecording(id) {
    if (state.recCache.has(id)) return state.recCache.get(id);
    const rec = parseRecording(await getJson(`data/rec/${id}.json`), sensors.map((s) => s.sensorId));
    state.recCache.set(id, rec);
    return rec;
  }

  async function loadScenario(id, t0) {
    try {
      const rec = await loadRecording(id);
      state.scenarioId = id;
      const old = state.player;
      state.player = new RecordingPlayer(rec, store, { loop: old?.loop ?? true, speed: old?.speed ?? 1 });
      state.player.playing = old?.playing ?? true; // 일시정지 상태도 이어 간다
      state.player.seek(t0);
      state.lastSec = -1;
      ui.setupTimebar(rec.n, rec.events);
      ui.setScenarios(index, id);
      ui.renderTransport(state.player);
      refresh();
    } catch (e) {
      console.error(e);
      badge.className = 'badge closed';
      badge.textContent = `녹화를 열 수 없다: ${e.message}`;
    }
  }

  async function startRecording() {
    if (state.live) {
      state.live.stop();
      state.live = null;
    }
    state.mode = 'rec';
    panel.show(false);
    store.clear();
    ui.setMode('rec', '녹화 재생 (실시간 아님)');
    await loadScenario(state.scenarioId, params.t);
  }

  function startLive(url) {
    state.player = null;
    panel.show(false);
    store.clear();
    ui.setMode('connecting', '라이브 연결 중');
    state.live = new LiveClient(url, store, {
      onState: (s, c) => {
        const text = { connecting: '라이브 연결 중', open: '라이브 연결됨', closed: `연결 끊김, ${Math.round(c.retryInMs / 1000)}초 뒤 다시 시도`, idle: '라이브 중지' }[s];
        ui.setMode(s === 'open' ? 'open' : s === 'closed' ? 'closed' : 'connecting', text);
        ui.setLiveText(`${url}  ${text}`);
      },
    });
    state.live.start();
    $('live-info').hidden = false;
    $('transport').hidden = true;
  }

  let lastRefresh = { version: -1, at: 0 };
  function refresh() {
    lastRefresh = { version: store.version, at: performance.now() };
    ui.renderAggregates();
    ui.renderAlarms(sensorInfo, state.mode);
    if (state.mode === 'sim' && state.sim) panel.renderLog(state.sim.log);
    ui.renderDetail(state.view);
    if (flow.stage === 'exterior') ui.renderExterior(summarize(store, rackKeys));
  }

  // ---- 장면 조작: 선택, 말풍선, 키보드 ----
  const canvas = $('canvas');
  const rect = () => canvas.getBoundingClientRect();
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // 끌기는 선택이 아니다
    const r = rect();
    if (flow.stage === 'exterior') {
      if (scene.pickBuilding((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)) queue.push({ name: 'view.goto', value: 'hall' });
      return;
    }
    const eq = scene.pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (eq) selectEquipment(eq);
    else if (state.selected) selectEquipment(state.selected); // 빈 곳: 해제
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return ui.hideTooltip();
    const r = rect();
    if (flow.stage === 'exterior') return canvas.classList.toggle('over-building', scene.pickBuilding((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
    const eq = scene.pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    scene.hover(eq);
    if (!eq) return ui.hideTooltip();
    const m = eq.startsWith('rack') ? store.metric(eq, VIEWS[state.view].metric) : store.metric(eq, 'fan_speed');
    const unit = eq.startsWith('rack') ? VIEWS[state.view].unit : '%';
    const label = eq.startsWith('rack') ? VIEWS[state.view].label : METRIC_LABEL.fan_speed;
    ui.showTooltip(`${prettyName(eq)}  ${label} ${m && Number.isFinite(m.value) ? m.value.toFixed(1) : '–'} ${unit}`, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('pointerleave', () => (scene.hover(null), ui.hideTooltip()));

  // 방향키로 랙 이동(FR-34): 줄은 위아래, 같은 줄은 좌우
  const racks = sceneData.racks;
  const byRow = new Map();
  racks.forEach((r) => {
    if (!byRow.has(r.row)) byRow.set(r.row, []);
    byRow.get(r.row).push(r);
  });
  for (const list of byRow.values()) list.sort((a, b) => a.min[0] - b.min[0]);
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  function moveSelection(dRow, dCol) {
    const cur = state.selected && racks.find((r) => r.name.toLowerCase() === state.selected);
    if (!cur) return selectEquipment(racks[0].name.toLowerCase(), true);
    const ri = Math.min(Math.max(rows.indexOf(cur.row) + dRow, 0), rows.length - 1);
    const list = byRow.get(rows[ri]);
    const ci = Math.min(Math.max(byRow.get(cur.row).indexOf(cur) + dCol, 0), list.length - 1);
    selectEquipment(list[ci].name.toLowerCase(), true);
  }
  canvas.addEventListener('keydown', (e) => {
    if (flow.stage !== 'hall') return;
    const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    moveSelection(d[0], d[1]);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest?.('dialog')) return void queue.push({ name: 'view.back' });
    if (e.target.closest?.('select, input, textarea, dialog, button')) return;
    if (e.key === 'Enter' && flow.stage === 'exterior') return void queue.push({ name: 'view.goto', value: 'hall' });
    if (!state.player) return;
    if (e.key === ' ') {
      e.preventDefault();
      state.player.playing = !state.player.playing;
      ui.renderTransport(state.player);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target === canvas) return;
      const step = (e.shiftKey ? 30 : 5) * (e.key === 'ArrowLeft' ? -1 : 1);
      state.player.seek(state.player.time + step);
      refresh();
    }
  });

  // ---- 크기와 반복 ----
  const stage = $('stage');
  const resize = () => scene.resize(stage.clientWidth, stage.clientHeight);
  new ResizeObserver(resize).observe(stage);
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if ((state.mode === 'rec' || state.mode === 'sim') && state.player) {
      const before = Math.floor(state.player.time);
      state.player.advance(dt);
      if (Math.floor(state.player.time) !== before || state.lastSec < 0) {
        state.lastSec = Math.floor(state.player.time);
        refresh();
      }
      ui.renderTransport(state.player);
    } else if (state.live) {
      if (state.live.flush()) refresh();
      const age = state.live.lastMessageAt ? Math.round((Date.now() - state.live.lastMessageAt) / 1000) : null;
      if (state.live.state === 'open') ui.setLiveText(`${state.live.url}  마지막 수신 ${age === null ? '–' : `${age}초 전`}, 버린 메시지 ${state.live.dropped}건`);
    }
    // 값이 바뀌었는데 아직 반영하지 않았다면(시간 막대 밖의 이동, 라이브 등) 화면 조각을 갱신한다. 라이브는 초당 4번까지만.
    if (store.version !== lastRefresh.version && now - lastRefresh.at > 250) refresh();
    scene.update(dt, now / 1000);
    requestAnimationFrame(frame);
  }

  setView(state.view);
  if (params.liveError) console.warn(`라이브 주소를 쓰지 않는다: ${params.liveError}`);
  if (params.live) {
    state.mode = 'live';
    startLive(params.live);
  } else if (params.mode === 'sim') {
    startSim(params.scenario ?? 'normal');
  } else {
    await startRecording();
  }
  if (params.liveError) {
    badge.textContent = `${badge.textContent} (라이브 주소 거부: ${params.liveError})`;
  }
  applyStage(true);
  queue.setReady(); // 장면이 준비되기 전에 들어온 명령은 여기서 실행된다
  requestAnimationFrame(frame);

  // 점검과 자동 캡처용 훅(읽기 전용 상태 노출)
  window.__viewer = { state, store, scene, selectEquipment, setView, loadScenario, startSim, panel, flow, queue, dispatch: (c) => queue.push(c) };
}

main();
