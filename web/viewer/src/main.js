// 시작과 화면 조립 (docs/18 8.1장). 입력(녹화 또는 라이브)은 같은 저장소를 갱신하고 화면은 저장소만 읽는다.
import { CommandQueue, FlowState, summarize } from './flow.js';
import { alarmSets, buildCameras } from './cctv.js';
import { CctvPanel } from './cctv_ui.js';
import { InsightPanel } from './sim/insight_panel.js';
import { detectQuality, browserEnv, lowerTier, SETTINGS } from './quality.js';
import { HallScene } from './scene.js';
import { VIEWS } from './views.js';
import { SensorStore } from './store.js';
import { SCENARIOS } from './sim/core.js';
import { SimEngine, layoutFrom } from './sim/engine.js';
import { SimPanel } from './sim/panel.js';
import { LibSource, LiveSource, RecSource, SimSource } from './sources.js';
import { UI, prettyName, METRIC_LABEL } from './ui.js';
import { checkLiveUrl, parseParams } from './url.js';
import { Boot, eventFraction } from './boot.js';
import { derive, initial as wsInitial, reduce as wsReduce } from './workspace.js';

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
  const boot = new Boot(document, reducedMotion);
  if (!webglOk()) {
    $('webgl-error').hidden = false;
    badge.textContent = 'WebGL 없음';
    boot.done(); // 안내 문구(#webgl-error)가 보이도록 로딩 화면은 치운다
    return;
  }
  let sensors;
  let sceneData;
  let index;
  let simInit = null;
  let libGroups = null;
  try {
    [sensors, sceneData, index] = await Promise.all([getJson('data/sensors.json'), getJson('data/scene.json'), getJson('data/index.json')]);
    simInit = await getJson('data/sim_init.json').catch(() => null); // 없으면 난수로 시작한다(필수 아님)
    libGroups = (await getJson('data/library.json').catch(() => null))?.groups ?? null; // 없으면 그룹 없이 한 줄로 보인다
  } catch (e) {
    badge.textContent = '자료를 못 받음';
    console.error(e);
    boot.fail('자료를 받지 못했다. 네트워크를 확인하고 다시 시도해 달라.');
    return;
  }
  boot.set('data', 'done');

  const ids = index.map((s) => s.id);
  const params = parseParams(location.search, ids);
  const store = new SensorStore(sensors);
  const sensorInfo = store.byId;
  const flow = new FlowState(params.stage ?? 'exterior');
  const rackKeys = sceneData.racks.map((r) => r.name.toLowerCase());
  const tier = detectQuality(params.q, browserEnv());
  const scene = new HallScene($('canvas'), $('labels'), sceneData, store, { reducedMotion, stage: flow.stage, tier });
  const qsel = document.getElementById('quality-sel');
  if (qsel) qsel.value = params.q ?? 'auto';

  scene.setSky(params.sky);
  if (params.sky === 'dusk') {
    const b = document.getElementById('sky-btn');
    b.setAttribute('aria-pressed', 'true');
    b.textContent = '낮으로 보기';
  }
  // 건물 모델(glb)도 화면이 뜬 뒤에 받는다. 실패하면 단순 상자 건물로 계속 쓴다.
  const modelP = scene
    .loadExteriorModel(BASE, (e) => {
      const f = eventFraction(e);
      if (f !== null) boot.set('model', f * 0.95); // 받기가 끝난 뒤 해석하는 시간을 남겨 둔다
    })
    .then(() => boot.set('model', 'done'))
    .catch((e) => {
      boot.set('model', 'skip');
      console.warn('건물 모양을 받지 못해 상자로 보여 준다:', e.message);
    });

  // 공기 흐름 속도장도 화면이 뜬 뒤에 받는다. 실패하면 단추를 숨기고 흐름 없이 쓴다.
  const flowP = scene
    .loadAirflow(BASE)
    .then(() => {
      document.getElementById('flow-btn').hidden = false;
      boot.set('flow', 'done');
    })
    .catch((e) => {
      boot.set('flow', 'skip');
      console.warn('공기 흐름을 받지 못해 생략한다:', e.message);
    });

  // 장비 모양(glb)은 화면이 뜬 뒤에 받는다. 실패하면 단순 상자로 계속 쓴다.
  // 낮은 화질(모바일, 저사양)에서는 랙 60기 모델(삼각형 약 27만 개)을 자동으로 받지 않고, 단추를 누르면 받는다.
  const autoModels = params.models && SETTINGS[tier].hallModels;
  scene.useModels = autoModels;
  let modelsState = autoModels ? 'loading' : 'off';
  let modelsPromise = null;
  const modelBtn = document.getElementById('model-btn');
  const ensureModels = () => {
    modelsPromise ??= scene
      .loadModels(BASE)
      .then(() => {
        modelsState = 'ready';
        modelBtn.hidden = false;
      })
      .catch((e) => {
        modelsState = 'failed';
        modelsPromise = null;
        console.warn('장비 모양을 받지 못해 상자로 보여 준다:', e.message);
      });
    return modelsPromise;
  };
  if (autoModels) {
    ensureModels().then(() => modelBtn.setAttribute('aria-pressed', 'true'));
  } else if (params.models) {
    modelBtn.hidden = false; // 낮은 화질: 눌러서 받는다
    modelBtn.setAttribute('aria-pressed', 'false');
    modelsState = 'deferred';
  }

  // 데이터 출처(녹화, 시뮬레이션, 라이브/서버)는 어댑터가 같은 모양으로 감싼다(src/sources.js). 지금 쓰는 출처는 source 하나다.
  let source = null;
  const state = {
    simScenario: params.scenario ?? 'normal',
    view: params.view ?? 'temp_in',
    selected: null,
    stage: flow.stage,
    // 아래는 지금 출처에서 읽는 값(점검 도구와 기존 코드가 같은 이름으로 읽는다)
    get mode() { return source?.kind ?? 'rec'; }, // rec | sim | live
    get server() { return !!source?.control; }, // 로컬 계산 서버에 조작을 보내는 라이브
    get player() { return source?.player ?? null; },
    get sim() { return simSource?.runner ?? null; },
    get live() { return source?.kind === 'live' ? source.client : null; },
    get scenarioId() { return recSource.scenarioId ?? params.scenario ?? 'normal'; },
  };
  // 모니터링은 이상 상황 기록만, 시뮬레이션(미리 계산한 값)은 상태와 시나리오 모음 전체. 같은 파일은 한 번만 받는다.
  const recCache = new Map();
  const sensorIds = sensors.map((s) => s.sensorId);
  const loadRec = (file) => getJson(`data/rec/${file}.json`);
  const recSource = new RecSource({ store, sensorIds, index: index.filter((i) => !i.group || i.group === 'event'), loadJson: loadRec, cache: recCache });
  const libSource = new LibSource({ store, sensorIds, index, loadJson: loadRec, cache: recCache, groups: libGroups });
  let simSource = null; // 패널이 만들어진 뒤에 만든다

  const ui = new UI(store, {
    onSelect: (eq, focus) => selectEquipment(eq, focus),
    onView: (v) => setView(v),
    onScenario: (id) => (state.server ? serverControl({ kind: 'scenario', name: ((state.simScenario = id), id) }) : state.mode === 'sim' ? startSim(id) : state.mode === 'lib' ? startLibrary(id) : loadScenario(id, 0)),
    onMode: (m) => {
      // 왼쪽 메뉴 하나를 고르면 CCTV는 닫힌다. 이미 그 출처이면 출처는 다시 시작하지 않는다.
      dispatch({ type: 'overlay', value: null });
      if (!state.server && state.mode === m) return;
      if (m === 'rec') return startRecording();
      if (m === 'lib') return startLibrary();
      startSim(state.simScenario);
    },
    onCctv: () => dispatch({ type: 'overlay-toggle', value: 'cctv' }),
    onTimeline: (on) => dispatch({ type: 'timeline', on }),
    onServer: (url) => connectServer(url),
    onPlay: () => state.player && ((state.player.playing = !state.player.playing), ui.renderTransport(state.player)),
    onSpeed: (x) => state.player && ((state.player.speed = x), ui.renderTransport(state.player)),
    onSeek: (t) => state.player && (state.player.seek(t), refresh()),
    onLoop: (b) => state.player && (state.player.loop = b),
    onPreset: (p) => scene.setPreset(p),
    onLabels: (b) => scene.setLabels(b),
    onModels: async (b) => {
      if (b && !scene.modelsReady) await ensureModels();
      scene.setModels(b);
    },
    onFlow: (b) => scene.setAirflow(b),
    onHeat: (on) => dispatch({ type: 'heat', on }),
    onSky: (n) => scene.setSky(n),
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
      onFan: (c, v) => (state.server ? serverControl({ kind: 'crac_fan', target: c, value: v }) : state.sim?.setFan(c, v)),
      onPower: (t, v) => (state.server ? serverControl({ kind: 'rack_power_scale', target: t, value: v }) : state.sim?.setPowerScale(t, v)),
      onSelectedPower: (r, v) => (state.server ? serverControl({ kind: 'rack_power_scale', target: r, value: v }) : state.sim?.setPowerScale(r, v)),
      onReset: () => (state.server ? serverControl({ kind: 'scenario', name: state.simScenario }) : startSim(state.simScenario)),
      onSpeed: (x) => serverControl({ kind: 'speed', value: x }),
    },
    prettyName,
  );
  const layout = layoutFrom(sceneData.racks, sensors);
  panel.build(layout.cracs, simRows);
  const rackRow = new Map(sceneData.racks.map((r) => [r.name.toLowerCase(), r.row]));
  const insight = new InsightPanel({
    store,
    rackKeys,
    rowOf: (k) => rackRow.get(k),
    warnIn: sensors.find((s) => s.metric === 'temp_in')?.warn ?? 27,
    rated: sensors.find((s) => s.equipmentType === 'rack' && s.metric === 'power')?.warn ?? undefined, // 랙 전력 주의 기준을 정격으로 본다(센서 정의가 기준)
    supplyWarn: sensors.find((s) => s.metric === 'supply_temp')?.warn ?? null,
    pretty: prettyName,
    onSupply: (v) => state.sim?.setSupply(v),
    onScenario: (id) => ui.h.onScenario(id),
  });

  simSource = new SimSource({
    store,
    scenarios: SCENARIOS,
    makeEngine: () => new SimEngine({ sensors, ...layout, seed: 7, basePower: simInit?.basePower ?? null, phase: simInit?.phase ?? null }),
    onEvent: (_e, engine) => panel.syncFromEngine(engine),
  });

  // ---- 출처 전환: 어떤 출처든 이 경로 하나로 바뀐다 ----
  // 모드 표시와 패널(출처가 정하는 부분). 연결 상태가 바뀔 때도 쓴다.
  function presentMode(d) {
    ui.setMode(d.badge.mode, d.badge.text);
    dispatch({ type: 'mode', mode: d.badge.mode, control: d.control });
  }
  function present(src) {
    const d = src.describe();
    presentMode(d);
    panel.setServerMode(d.panel === 'server');
    panel.show(d.panel !== 'none');
    if (d.timebar) ui.setupTimebar(d.timebar.n, d.timebar.events);
    ui.setScenarioCard(d.card.title, d.card.desc, d.card.events, d.card.seekable);
    if (d.scenarios) ui.setScenarios(d.scenarios.list, d.scenarios.current, d.scenarios.groups);
    if (src.engine) {
      panel.syncFromEngine(src.engine);
      panel.setSelected(state.selected, src.engine);
    }
    if (src.player) ui.renderTransport(src.player);
    refresh();
  }
  async function useSource(next, args) {
    if (source && source !== next) {
      source.close();
      store.clear(); // 다른 출처의 값이 남지 않게(같은 녹화 안에서 시나리오만 바꿀 때는 지우지 않는다)
    }
    const prev = source;
    source = next;
    resetServerModel();
    presentMode(next.describe()); // 열기에 실패해도 어느 출처인지는 보인다
    try {
      await next.open(args);
    } catch (e) {
      console.error(e);
      badge.className = 'badge closed';
      badge.textContent = `녹화를 열 수 없다: ${e.message}`;
      return prev === next;
    }
    present(next);
    return true;
  }
  const startSim = (id = 'normal') => {
    state.simScenario = SCENARIOS[id] ? id : 'normal';
    return useSource(simSource, { scenarioId: state.simScenario });
  };

  // ---- 가상 CCTV (docs/27 10장) ----
  const cctvCams = buildCameras(sceneData);
  const cctvSets = () => alarmSets(sceneData, (k) => store.worstAlarm(k));
  const cctv = new CctvPanel({
    onTiles: (t) => scene.setCctv(t),
    onClosed: () => dispatch({ type: 'overlay', value: null }), // 칸 안의 닫기 단추로 닫은 경우
  }, tier);
  const cctvClock = () => {
    const t = state.mode === 'sim' ? state.sim?.time : state.player?.time;
    if (!Number.isFinite(t)) return '가상 시각 –';
    const s = Math.floor(t);
    return `가상 시각 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  // ---- 작업 공간 상태: 모든 화면 전환은 dispatch 하나로 지난다(src/workspace.js 계층 설명) ----
  let ws = wsInitial;
  let vm = derive(ws);
  function dispatch(action) {
    const next = wsReduce(ws, action);
    if (next === ws) return;
    const prev = vm;
    ws = next;
    vm = derive(ws);
    ui.apply(vm, ws);
    if (vm.heat !== prev.heat) scene.setHeat(vm.heat);
    if (vm.cctvOpen && !cctv.isOpen) cctv.open(cctvCams, cctvSets(), scene.tier);
    else if (!vm.cctvOpen && cctv.isOpen) cctv.close();
  }
  ui.apply(vm, ws);
  window.__ws = () => ws;

  // ---- 화면 단계와 이동 명령 (docs/20) ----
  // 서버실 껍데기는 처음 서버실에 들어갈 때 받는다(첫 로딩 용량을 아끼려고). 실패하면 옛 어두운 바닥으로 계속 쓴다.
  let shellPromise = null;
  function ensureShell() {
    shellPromise ??= scene.loadHallShell(BASE).catch((e) => {
      console.warn('서버실 껍데기를 받지 못해 단순 바닥으로 보여 준다:', e.message);
    });
    return shellPromise;
  }
  function applyStage(instant = false) {
    if (flow.stage === 'hall') ensureShell();
    scene.setStage(flow.stage, instant);
    dispatch({ type: 'stage', stage: flow.stage });
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
        else if (state.mode === 'lib' && index.some((x) => x.id === c.value)) startLibrary(c.value);
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

  const loadScenario = (id, t0) => useSource(recSource, { scenarioId: id, t: t0 });
  const startRecording = () => useSource(recSource, { scenarioId: state.scenarioId, t: params.t });
  // 미리 계산한 값: 모니터링에서 보던 시나리오가 목록에 있으면 그대로 이어서 보여 준다
  const startLibrary = (id) => useSource(libSource, { scenarioId: id ?? libSource.scenarioId ?? state.scenarioId, t: 0 });

  // 서버에 조작을 보낸다. 연결이 안 되어 있으면 화면에 알린다.
  function serverControl(c) {
    if (!(source?.kind === 'live' && source.send(c))) {
      badge.textContent = '서버에 연결되어 있지 않아 조작을 보내지 못했다';
      return false;
    }
    return true;
  }

  // 서버가 알려 준 조작 상태(snapshot의 controls와 그 뒤의 이벤트)로 슬라이더를 맞춘다. 서버가 기준이다.
  const serverModel = { fan: {}, powerScale: {}, racks: layout.racks };
  let ctlSeen;
  let evSeen = 0;
  function resetServerModel() {
    const c = store.controls;
    serverModel.fan = Object.fromEntries(layout.cracs.map((x) => [x, c?.fan?.[x] ?? 1]));
    serverModel.powerScale = Object.fromEntries(layout.racks.map((r) => [r.name, c?.powerScale?.[r.name] ?? 1]));
    evSeen = 0;
  }
  resetServerModel();
  function syncServerPanel() {
    if (store.controls !== ctlSeen || store.events.length < evSeen) {
      ctlSeen = store.controls;
      resetServerModel();
    }
    for (; evSeen < store.events.length; evSeen++) {
      const e = store.events[evSeen];
      if (e.kind === 'crac_fan' && e.target in serverModel.fan) serverModel.fan[e.target] = e.value;
      else if (e.kind === 'rack_power_scale') {
        const names = e.target.startsWith('row:') ? layout.racks.filter((r) => r.row === Number(e.target.slice(4))).map((r) => r.name) : [e.target];
        for (const n of names) if (n in serverModel.powerScale) serverModel.powerScale[n] = e.value;
      }
    }
    panel.syncFromEngine(serverModel);
    panel.renderLog(store.events);
    panel.setSelected(state.selected, serverModel);
  }

  // 화면의 "로컬 서버" 단추와 주소 매개변수 server=가 부른다. 주소가 틀리면 이유 문장을, 맞으면 true를 돌려준다.
  function connectServer(text) {
    const r = checkLiveUrl(text);
    if (!r.ok) return r.reason;
    startLive(r.url, true);
    return true;
  }

  function startLive(url, control = false) {
    const src = new LiveSource({
      store,
      url,
      control,
      simList: simSource.list,
      current: state.simScenario,
      onChange: () => {
        if (source !== src) return; // 이미 다른 출처로 옮겨 갔다
        const d = src.describe();
        presentMode(d);
        ui.setLiveText(`${url}  ${d.badge.text}`);
      },
    });
    return useSource(src);
  }

  let lastRefresh = { version: -1, at: 0 };
  function refresh() {
    lastRefresh = { version: store.version, at: performance.now() };
    ui.renderAggregates();
    ui.renderSummary(summarize(store, rackKeys), store.alarmLog);
    ui.renderAlarms(sensorInfo, state.mode);
    if (state.mode === 'sim' && state.sim) panel.renderLog(state.sim.log);
    if (state.server) syncServerPanel();
    if (state.mode === 'sim' || state.mode === 'lib' || state.server) insight.render(state.server || state.mode === 'lib' ? null : state.sim?.engine, state.mode === 'lib' ? libSource.scenarioId : state.simScenario, state.mode);
    ui.renderDetail(state.view);
    if (flow.stage === 'exterior') ui.renderExterior(summarize(store, rackKeys));
    if (cctv.isOpen) cctv.setAlarms(cctvSets());
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
    if (e.key === 'Escape' && !e.target.closest?.('dialog')) return ws.overlay ? dispatch({ type: 'overlay', value: null }) : void queue.push({ name: 'view.back' });
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

  // 프레임이 낮으면(처음 몇 초 평균 22 미만) 화질을 한 단계 낮춘다. 주소에 q가 있거나 자동 시험 브라우저면 하지 않는다.
  const guard = { on: !params.q && !navigator.webdriver, frames: 0, t0: 0, tier };
  function perfGuard(now) {
    if (!guard.on) return;
    if (!guard.t0) guard.t0 = now + 2500; // 처음 2.5초는 모델을 받느라 느리니 건너뛴다
    if (now < guard.t0) return;
    guard.frames++;
    if (now - guard.t0 < 3000) return;
    const fps = (guard.frames * 1000) / (now - guard.t0);
    const lower = lowerTier(guard.tier);
    guard.frames = 0;
    guard.t0 = now + 1500;
    if (fps < 22 && lower) {
      guard.tier = lower;
      scene.applyQuality(lower);
      if (qsel) qsel.title = `프레임이 낮아 화질을 ${lower}로 낮췄다`;
      console.info(`프레임 ${fps.toFixed(0)}fps: 화질을 ${lower}로 낮춤`);
    } else {
      guard.on = false; // 충분하면 끝
    }
  }

  let last = performance.now();
  function frame(now) {
    perfGuard(now);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (source) {
      if (source.advance(dt)) refresh();
      if (source.player) ui.renderTransport(source.player);
      const st = source.statusText();
      if (st) ui.setLiveText(st);
    }
    // 값이 바뀌었는데 아직 반영하지 않았다면(시간 막대 밖의 이동, 라이브 등) 화면 조각을 갱신한다. 라이브는 초당 4번까지만.
    if (store.version !== lastRefresh.version && now - lastRefresh.at > 250) refresh();
    if (cctv.isOpen) cctv.setTime(cctvClock());
    scene.update(dt, now / 1000);
    requestAnimationFrame(frame);
  }

  setView(state.view);
  if (params.liveError) console.warn(`라이브 주소를 쓰지 않는다: ${params.liveError}`);
  if (params.server) {
    await startLive(params.server, true);
  } else if (params.live) {
    await startLive(params.live);
  } else if (params.mode === 'sim') {
    await startSim(params.scenario ?? 'normal');
  } else if (params.mode === 'lib') {
    await startLibrary(params.scenario ?? undefined);
  } else {
    await startRecording();
  }
  if (params.liveError) {
    badge.textContent = `${badge.textContent} (라이브 주소 거부: ${params.liveError})`;
  }
  applyStage(true);
  queue.setReady(); // 장면이 준비되기 전에 들어온 명령은 여기서 실행된다
  requestAnimationFrame(frame);
  // 모델과 기류 데이터가 끝나고 첫 장면이 두 번 그려진 뒤에 로딩 화면을 치운다. 너무 오래 걸리면(25초) 받기는 계속하고 화면만 먼저 보여 준다.
  const settled = Promise.allSettled([modelP, flowP]);
  const waitMax = new Promise((r) => setTimeout(r, 25000));
  Promise.race([settled, waitMax]).then(() => requestAnimationFrame(() => requestAnimationFrame(() => boot.done())));

  // 점검과 자동 캡처용 훅(읽기 전용 상태 노출)
  window.__viewer = { getModelsState: () => modelsState, state, store, scene, selectEquipment, setView, loadScenario, startSim, startLibrary, libScenario: () => libSource.scenarioId, panel, flow, queue, dispatch: (c) => queue.push(c) };
}

main().catch((e) => {
  // 시작 중 예상 못 한 오류가 나도 로딩 화면이 영원히 남지 않게 이유와 다시 시도를 보인다
  console.error(e);
  new Boot(document, reducedMotion).fail('화면을 시작하지 못했다. 다시 시도해 달라.');
});
