// 화면 조각들(상단 집계, 상세 패널, 알람 목록, 시간 막대, 범례, 추이 그래프). 값은 textContent로만 넣는다(6.4장).
import { ALARM_LABEL, CONFIDENCE_HELP, CONFIDENCE_LABEL, barFraction, confidenceColor, tempColor, toCss } from './colors.js';
import { VIEWS } from './views.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const METRIC_LABEL = {
  temp_in: '입구 온도',
  temp_out: '배기 온도',
  power: '전력',
  fan_speed: '팬 속도',
  return_temp: '회수 온도',
  supply_temp: '급기 온도',
};
const UNIT_LABEL = { degC: '°C', kW: 'kW', percent: '%' };
const pad = (n) => String(Math.floor(n)).padStart(2, '0');
export const clock = (sec) => `${pad(sec / 60)}:${pad(sec % 60)}`;
// rack_01 -> Rack_01, crac_01 -> CRAC_01 (장면 USD의 이름과 같다)
export const prettyName = (key) => (key.startsWith('crac') ? key.toUpperCase() : key.replace(/^(\w)/, (m) => m.toUpperCase()));
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export class UI {
  constructor(store, handlers) {
    this.store = store;
    this.h = handlers; // { onSelect(eq), onView(v), onScenario(id), onPlay(), onSpeed(x), onSeek(t), onLoop(b), onPreset(p), onLabels(b), onBackToRec(), onEnter(), onBack(), onMode(m), onModels(on), onFlow(on), onHeat(on), onSky(name), onServer(url) }
    this.mode = 'rec';
    this.sheet = 'peek';
    this.ready = false;
    this.metricTab = null;
    this.heatOn = false;
    this.selected = null;
    this._lastAlarmCount = -1;
    this._lastDetailKey = '';
    this.tab = 'summary';
    this.bind();
    this.initTabs();
    this.fillHelp();
  }

  bind() {
    $('scenario-select').addEventListener('change', (e) => this.h.onScenario(e.target.value));
    document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', (e) => this.h.onView(e.target.value)));
    document.querySelectorAll('#presets [data-preset]').forEach((b) => b.addEventListener('click', () => this.h.onPreset(b.dataset.preset)));
    $('labels-btn').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      this.h.onLabels(on);
    });
    $('model-btn').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      this.h.onModels(on);
    });
    $('heat-btn').addEventListener('click', (e) => {
      this.h.onHeat(!this.heatOn);
    });
    $('flow-btn').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      this.h.onFlow(on);
    });
    this.timelineOn = false;
    $('timeline-btn').addEventListener('click', () => this.h.onTimeline(!this.timelineOn));
    $('cctv-btn').addEventListener('click', () => this.h.onCctv());
    $('sky-btn').addEventListener('click', (e) => {
      const dusk = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(dusk));
      e.currentTarget.textContent = dusk ? '낮으로 보기' : '저녁으로 보기';
      this.h.onSky(dusk ? 'dusk' : 'day');
    });
    $('quality-sel').addEventListener('change', (e) => {
      const u = new URL(location.href);
      if (e.target.value === 'auto') u.searchParams.delete('q');
      else u.searchParams.set('q', e.target.value);
      location.href = u.toString();
    });
    $('play-btn').addEventListener('click', () => this.h.onPlay());
    document.querySelectorAll('#speeds [data-speed]').forEach((b) => b.addEventListener('click', () => this.h.onSpeed(Number(b.dataset.speed))));
    $('time-slider').addEventListener('input', (e) => this.h.onSeek(Number(e.target.value)));
    $('loop-check').addEventListener('change', (e) => this.h.onLoop(e.target.checked));
    // 휴대폰: 정보 패널은 아래에서 올라오는 시트(접힘 / 반 / 전체). 손잡이를 누르면 한 단계씩, 위아래로 밀면 그 방향으로
    const handle = $('sheet-handle');
    let dragY = null;
    handle.addEventListener('pointerdown', (e) => { dragY = e.clientY; handle.setPointerCapture?.(e.pointerId); });
    handle.addEventListener('pointerup', (e) => {
      if (dragY === null) return;
      const dy = e.clientY - dragY;
      dragY = null;
      if (Math.abs(dy) < 24) this.cycleSheet();
      else this.stepSheet(dy < 0 ? 1 : -1);
    });
    handle.addEventListener('pointercancel', () => (dragY = null));
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.cycleSheet(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.stepSheet(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.stepSheet(-1); }
    });
    $('side-toggle').addEventListener('click', () => this.setSideOpen($('side').classList.contains('collapsed')));
    $('help-btn').addEventListener('click', () => $('help-dialog').showModal());
    $('live-back').addEventListener('click', () => this.h.onBackToRec());
    $('enter-btn').addEventListener('click', () => this.h.onEnter());
    $('back-btn').addEventListener('click', () => this.h.onBack());
    $('server-cta-btn').addEventListener('click', () => this.openServerDialog());
    $('sc-max').addEventListener('click', (e) => e.currentTarget.dataset.rack && this.h.onSelect(e.currentTarget.dataset.rack, true));
    document.querySelectorAll('#mode-group [data-mode], #rail [data-mode]').forEach((b) => b.addEventListener('click', () => (b.dataset.mode === 'server' ? this.openServerDialog() : this.h.onMode(b.dataset.mode))));
    $('server-connect').addEventListener('click', () => {
      const r = this.h.onServer($('server-url').value.trim());
      $('server-error').hidden = r === true;
      if (r !== true) $('server-error').textContent = r;
      else $('server-dialog').close();
    });
    $('server-url').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('server-connect').click()));
  }

  // ---- 오른쪽 패널의 탭: 요약 / 장비 / 조작(시뮬레이션, 서버일 때만) / 알람 ----
  initTabs() {
    const tabs = [...document.querySelectorAll('#side-tabs [data-tab]')];
    for (const t of tabs) {
      t.addEventListener('click', () => this.showTab(t.dataset.tab));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const open = tabs.filter((x) => !x.hidden);
        const i = open.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
        const next = open[(i + open.length) % open.length];
        next.focus();
        this.showTab(next.dataset.tab);
        e.preventDefault();
      });
    }
    this.showTab('summary');
    this.ready = true;
  }

  showTab(name) {
    this.tab = name;
    if (this.ready && this.sheet === 'peek' && window.matchMedia('(max-width: 900px)').matches) this.setSheet('half'); // 휴대폰: 탭이나 선택으로 접힌 시트를 반으로 올림
    if (document.getElementById('side').classList.contains('collapsed') && this._sideTouched !== false) this.setSideOpen(true);
    for (const t of document.querySelectorAll('#side-tabs [data-tab]')) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`pane-${t.dataset.tab}`).hidden = !on;
    }
  }

  fillHelp() {
    const ul = $('help-conf');
    for (const k of ['ok', 'caution', 'low', 'fallback']) {
      const li = el('li');
      const chip = el('span', `chip c-${k}`, CONFIDENCE_LABEL[k]);
      li.append(chip, document.createTextNode(CONFIDENCE_HELP[k]));
      ul.append(li);
    }
  }

  // ---- 상단 ----
  // groups(선택)가 있고 목록이 둘 이상의 그룹에 걸치면 그룹별로 묶어 보인다(예: 이상 상황, 급기 온도, 부하)
  setScenarios(list, current, groups = null) {
    const sel = $('scenario-select');
    sel.replaceChildren();
    const kinds = new Set(list.map((s) => s.group).filter(Boolean));
    const option = (s) => {
      const o = el('option', '', s.title);
      o.value = s.id;
      o.title = s.note;
      return o;
    };
    if (groups && kinds.size > 1) {
      for (const g of groups) {
        const items = list.filter((s) => s.group === g.id);
        if (!items.length) continue;
        const og = el('optgroup');
        og.label = g.title;
        og.append(...items.map(option));
        sel.append(og);
      }
    } else {
      sel.append(...list.map(option));
    }
    sel.value = current;
  }

  // 모드 표시(글자와 색)만 맡는다. 단추와 조각의 보임·눌림은 apply()가 한곳에서 정한다.
  setMode(mode, text) {
    const b = $('mode-badge');
    b.className = `badge ${mode}`;
    b.textContent = text;
    this.mode = mode;
  }

  // 아래 시트 단계: peek(접힘) < half < full
  setSheet(s) {
    this.sheet = s;
    $('side').dataset.sheet = s;
    $('sheet-handle').setAttribute('aria-expanded', String(s !== 'peek'));
  }

  stepSheet(d) {
    const order = ['peek', 'half', 'full'];
    this.setSheet(order[Math.max(0, Math.min(2, order.indexOf(this.sheet) + d))]);
  }

  cycleSheet() {
    this.setSheet({ peek: 'half', half: 'full', full: 'peek' }[this.sheet]);
  }

  // 오른쪽 정보 패널 접기/펴기(PC 폭에서 3D 위에 떠 있을 때)
  setSideOpen(open) {
    $('side').classList.toggle('collapsed', !open);
    $('main').classList.toggle('side-closed', !open);
    $('side-toggle').setAttribute('aria-pressed', String(open));
  }

  openServerDialog() {
    $('server-error').hidden = true;
    $('server-dialog').showModal();
    $('server-url').focus();
  }

  // 미리 계산한 값을 어디서 받았는지(서버, 사이트에 포함된 파일)
  setDataSource(text) {
    $('data-source').textContent = `미리 계산한 값: ${text}`;
  }

  setLiveText(t) {
    $('live-text').textContent = t;
  }

  // 화면 반영 계층: workspace.derive()가 만든 값을 DOM에 한 번에 적용한다. 보임·눌림은 여기서만 바꾼다.
  apply(vm, ws) {
    const prevStage = this.stage;
    this.stage = ws.stage;
    this.heatOn = vm.heat;
    this.timelineOn = ws.timeline;
    // 왼쪽 메뉴: 눌린 단추는 하나
    $('rail').hidden = vm.rail.hidden;
    for (const b of document.querySelectorAll('#rail button')) {
      const key = b.id === 'cctv-btn' ? 'cctv' : b.dataset.mode;
      const on = vm.rail.active === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    $('mode-group').querySelector('[data-mode="server"]').classList.toggle('on', vm.serverOn);
    // 3D 위 조각
    $('exterior-card').hidden = !vm.exteriorCard;
    $('stage-tools').hidden = vm.stageToolsHidden;
    $('back-btn').hidden = vm.backHidden;
    $('legend').hidden = vm.legendHidden;
    $('view-group').hidden = vm.viewGroupHidden;
    $('mode-badge').hidden = vm.modeBadgeHidden;
    $('heat-btn').setAttribute('aria-pressed', String(vm.heat));
    $('timeline-btn').hidden = vm.timelineBtnHidden;
    $('timeline-btn').setAttribute('aria-pressed', String(ws.timeline));
    // 재생과 상단
    $('transport').hidden = vm.transportHidden;
    $('timebar').hidden = vm.timebarHidden;
    $('loop-label').hidden = vm.timebarHidden;
    $('live-info').hidden = vm.liveInfoHidden;
    $('scenario-select').disabled = vm.scenarioDisabled;
    // 오른쪽 패널 탭
    const extra = ['control', 'energy', 'prep'];
    const key = extra.map((t) => (vm.tabs[t] ? 1 : 0)).join('');
    const hadAny = !!this._tabKey && this._tabKey !== '000';
    const changed = key !== this._tabKey;
    this._tabKey = key;
    for (const t of extra) $(`tab-${t}`).hidden = !vm.tabs[t];
    if (extra.includes(this.tab) && !vm.tabs[this.tab]) this.showTab(key === '000' ? 'summary' : vm.homeTab); // 보던 탭이 사라지면 옮긴다
    else if (changed && !hadAny && key !== '000') this.showTab(vm.homeTab); // 처음 나타나면 그 출처의 첫 탭을 연다
    $('server-cta').hidden = !vm.serverCta;
    $('data-source').hidden = ws.mode !== 'lib';
    // 단계가 바뀐 때만
    if (prevStage !== ws.stage) {
      const ext = ws.stage === 'exterior';
      $('stage').dataset.stage = ws.stage;
      $('canvas').setAttribute('aria-label', ext ? '데이터센터 건물 외관. 건물을 누르거나 Enter를 누르면 안으로 들어간다' : '데이터센터 3D 장면. 방향키로 랙을 선택할 수 있다');
      if (ext) $('enter-btn').focus({ preventScroll: true });
    }
    $('stage').dataset.overlay = vm.cctvOpen ? 'cctv' : '';
  }

  renderExterior(s) {
    const none = '데이터 없음';
    $('ext-total').textContent = s.facilityPower === null ? none : `${fmt(s.facilityPower, 1)} kW`;
    $('ext-status').textContent = !s.hasData ? none : s.alarms > 0 ? '주의 필요' : '정상';
    $('ext-status').dataset.state = !s.hasData ? 'none' : s.alarms > 0 ? 'alarm' : 'ok';
    $('ext-pue').textContent = s.pue === null ? none : fmt(s.pue, 2);
  }

  // 시나리오 이름과 설명, 일어나는 일 목록(녹화 재생에서만 눌러서 그 시각으로 이동)
  setScenarioCard(title, desc, events = [], seekable = false) {
    $('sc-title').textContent = title;
    $('sc-desc').textContent = desc;
    const ol = $('sc-events');
    ol.replaceChildren();
    $('sc-events-title').hidden = events.length === 0;
    for (const e of events) {
      const li = el('li');
      const t = el('time', '', clock(e.t));
      li.append(t, document.createTextNode(describeEvent(e)));
      if (seekable) {
        li.tabIndex = 0;
        li.classList.add('seekable');
        const go = () => this.h.onSeek(e.t);
        li.addEventListener('click', go);
        li.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), go()));
      }
      ol.append(li);
    }
  }

  // 지금 상황: 가장 높은 입구 온도 랙, 알람 수, 첫 알람 시각
  renderSummary(s, log) {
    const btn = $('sc-max');
    btn.textContent = s.maxTempIn === null ? '데이터 없음' : `${prettyName(s.maxRack)} ${fmt(s.maxTempIn, 1)} °C`;
    btn.disabled = s.maxRack === null;
    btn.dataset.rack = s.maxRack ?? '';
    $('sc-alarms').textContent = s.hasData ? `지금 ${s.alarms}건` : '데이터 없음';
    const first = log.find((a) => a.to !== 'normal');
    $('sc-first').textContent = first ? `${first.t !== undefined ? clock(first.t) : (first.ts ?? '').slice(11, 19)} ${prettyName(this.store.byId.get(first.sensorId)?.equipment ?? '')}` : '없음';
  }

  renderAggregates() {
    const a = this.store.aggregates;
    $('agg-it').textContent = Number.isFinite(a.it_power) ? `${fmt(a.it_power, 1)} kW` : '–';
    $('agg-cool').textContent = Number.isFinite(a.cooling_power) ? `${fmt(a.cooling_power, 1)} kW` : '–';
    $('agg-pue').textContent = Number.isFinite(a.pue) ? fmt(a.pue, 2) : '–';
  }

  // ---- 범례 ----
  renderLegend(viewKey) {
    const v = VIEWS[viewKey];
    $('legend-title').textContent = v.label;
    $('legend-min').textContent = String(v.cold);
    $('legend-max').textContent = `${v.hot} ${v.unit}`;
    const stops = [0, 1 / 3, 2 / 3, 1].map((t) => `${toCss(tempColor(v.cold + t * (v.hot - v.cold), v.cold, v.hot))} ${Math.round(t * 100)}%`);
    $('legend-ramp').style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  // ---- 재생 막대 ----
  setupTimebar(n, events) {
    const slider = $('time-slider');
    slider.max = String(n);
    const marks = $('event-marks');
    marks.replaceChildren();
    for (const e of events) {
      const i = el('i');
      i.style.left = `${(e.t / n) * 100}%`;
      i.title = `${clock(e.t)} ${describeEvent(e)}`;
      marks.append(i);
    }
    this.duration = n;
  }

  renderTransport(player) {
    $('play-btn').textContent = player.playing ? '⏸' : '▶';
    if (player.duration === null) {
      $('time-text').textContent = `${clock(player.time)} 경과`; // 직접 시뮬레이션은 끝이 없다
    } else {
      $('time-slider').value = String(player.time);
      $('time-text').textContent = `${clock(player.time)} / ${clock(player.duration)}`;
    }
    document.querySelectorAll('#speeds [data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === player.speed));
    $('loop-check').checked = player.loop;
  }

  // ---- 알람 목록 ----
  renderAlarms(sensorInfo, mode, startTs) {
    const log = this.store.alarmLog;
    const active = this.store.activeAlarms(); // 지금 이상인 센서 수. 기록(log)의 줄 수와 다르다(기록은 지나간 변화까지 쌓인다)
    if (log.length === this._lastAlarmCount && this._lastAlarmKey === log.at(-1) && active === this._lastActive) return;
    this._lastAlarmCount = log.length;
    this._lastAlarmKey = log.at(-1);
    this._lastActive = active;
    const list = $('alarm-list');
    list.replaceChildren();
    $('alarm-empty').hidden = log.length > 0;
    $('alarm-count').textContent = log.length ? `(지금 ${active}건, 기록 ${log.length}건)` : '';
    $('tab-alarm-count').textContent = String(Math.min(active, 99));
    $('tab-alarm-count').hidden = active === 0;
    $('tab-alarm-count').title = `지금 이상인 센서 ${active}개`;
    for (const a of [...log].reverse().slice(0, 60)) {
      const info = sensorInfo.get(a.sensorId);
      if (!info) continue;
      const li = el('li');
      li.tabIndex = 0;
      if (a.to === 'normal') li.classList.add('recovered');
      const when = a.t !== undefined ? clock(a.t) : (a.ts ?? '').slice(11, 19);
      const t = el('time', '', when);
      const chip = el('span', `chip a-${a.to}`, ALARM_LABEL[a.to]);
      li.append(t, document.createTextNode(`${prettyName(info.equipment)} ${METRIC_LABEL[info.metric] ?? info.metric} `), chip, document.createTextNode(` ${ALARM_LABEL[a.from]} → ${ALARM_LABEL[a.to]}, ${fmt(a.value, 1)} ${UNIT_LABEL[info.unit] ?? info.unit}`));
      const go = () => this.h.onSelect(info.equipment, true);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
      list.append(li);
    }
  }

  // ---- 상세 ----
  setSelected(equipment) {
    if (this.selected !== equipment) this.metricTab = null;
    this.selected = equipment;
    this._lastDetailKey = '';
    // 장비를 고르면 "장비" 탭을 보여 준다(조작 중이면 그대로 둔다). 선택을 풀면 요약으로 돌아간다.
    if (equipment && (this.tab === 'summary' || this.tab === 'alarms')) this.showTab('detail');
    else if (!equipment && this.tab === 'detail') this.showTab('summary');
  }

  renderDetail(viewKey) {
    const body = $('detail-body');
    const eq = this.selected;
    $('detail-empty').hidden = !!eq;
    body.hidden = !eq;
    if (!eq) return;
    const metrics = this.store.byEquipment.get(eq) ?? {};
    const order = eq.startsWith('rack') ? ['temp_in', 'temp_out', 'power'] : ['fan_speed', 'return_temp', 'supply_temp'];
    if (!this.metricTab || !metrics[this.metricTab]) this.metricTab = eq.startsWith('rack') ? VIEWS[viewKey].metric : 'fan_speed';
    // 값이 바뀌었을 때만 다시 만든다
    const key = `${eq}|${this.metricTab}|${this.store.version}`;
    if (key === this._lastDetailKey) return;
    this._lastDetailKey = key;
    body.replaceChildren();
    body.append(el('div', 'eq-name', prettyName(eq)));
    for (const m of order) {
      const id = metrics[m];
      if (!id) continue;
      const info = this.store.byId.get(id);
      const s = this.store.get(id);
      const row = el('div', 'row');
      const unit = UNIT_LABEL[info.unit] ?? info.unit;
      const valueText = s && Number.isFinite(s.value) ? `${fmt(s.value, 1)} ${unit}${s.quality === 'stale' ? ' (오래된 값)' : ''}` : '값 없음';
      const right = el('span');
      right.append(el('b', '', valueText), document.createTextNode(' '), el('span', `chip a-${s?.alarm ?? 'normal'}`, ALARM_LABEL[s?.alarm ?? 'normal']));
      row.append(el('span', '', METRIC_LABEL[m]), right);
      body.append(row);
    }
    // 보정 모델의 구간과 등급(입구 온도)
    const tin = this.store.metric(eq, 'temp_in');
    if (eq.startsWith('rack')) {
      const box = el('div', 'conf-box');
      if (tin && tin.confidence) {
        const frac = barFraction(tin);
        box.append(el('div', '', '보정 모델 (AI 대리 모델)'));
        const line = el('div');
        line.append(el('span', `chip c-${tin.confidence}`, CONFIDENCE_LABEL[tin.confidence]), document.createTextNode(CONFIDENCE_HELP[tin.confidence]));
        box.append(line);
        const bar = el('div', 'conf-bar');
        const fill = el('i');
        fill.style.width = `${Math.round(frac * 100)}%`;
        fill.style.background = toCss(confidenceColor(tin.confidence));
        bar.append(fill);
        box.append(bar);
        if (Number.isFinite(tin.lower) && Number.isFinite(tin.upper)) {
          const half = (tin.upper - tin.lower) / 2;
          box.append(el('div', 'muted', `90% 구간 ${fmt(tin.lower, 2)} ~ ${fmt(tin.upper, 2)} °C (± ${fmt(half, 2)})`));
        }
      } else {
        box.append(el('div', 'muted', '보정 정보 없음'));
      }
      body.append(box);
    }
    // 추이 그래프
    const tabs = el('div', 'tabs');
    for (const m of order) {
      if (!metrics[m]) continue;
      const b = el('button', m === this.metricTab ? 'on' : '', METRIC_LABEL[m]);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.metricTab = m;
        this._lastDetailKey = '';
        this.renderDetail(viewKey);
      });
      tabs.append(b);
    }
    body.append(tabs);
    const canvas = el('canvas');
    canvas.id = 'chart';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${prettyName(eq)} ${METRIC_LABEL[this.metricTab]} 최근 2분 추이`);
    body.append(canvas);
    drawChart(canvas, this.store.history.get(metrics[this.metricTab]) ?? [], this.store.byId.get(metrics[this.metricTab]));
  }

  // ---- 말풍선 ----
  showTooltip(text, x, y) {
    const t = $('tooltip');
    t.hidden = false;
    t.textContent = text;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }

  hideTooltip() {
    $('tooltip').hidden = true;
  }
}

export function describeEvent(e) {
  const pct = Number.isFinite(e.value) ? `${Math.round(e.value * 100)}%` : '';
  if (e.kind === 'crac_fan') return e.value === 0 ? `${prettyName(e.target)} 팬 정지` : `${prettyName(e.target)} 팬 속도 ${pct}`;
  if (e.kind === 'crac_off') return `${prettyName(e.target)} 정지`;
  if (e.kind === 'rack_power_scale') return `${String(e.target).startsWith('row:') ? `${Number(String(e.target).slice(4))}번 줄` : prettyName(e.target)} 랙 전력 ${pct}`;
  if (e.kind === 'rack_power') return `${prettyName(e.target)} 전력 변화`;
  return `${e.kind} ${e.target ?? ''}`.trim();
}

// 추이 그래프: 값 선, 90% 구간 띠, 알람 기준선(점선)
export function drawChart(canvas, hist, info) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 130;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const pts = hist.filter((p) => Number.isFinite(p.value));
  if (pts.length < 2) {
    g.fillStyle = '#6d7882';
    g.font = '12px "Pretendard Variable", system-ui';
    g.fillText('추이를 모으는 중', 10, h / 2);
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of hist) {
    for (const v of [p.value, p.lower, p.upper]) {
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  for (const t of [info.warn, info.critical]) {
    if (Number.isFinite(t) && t >= lo - (hi - lo) * 1.5 && t <= hi + (hi - lo) * 1.5 + 2) {
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  const pad = Math.max((hi - lo) * 0.1, 0.5);
  lo -= pad;
  hi += pad;
  const L = 36;
  const R = 8;
  const T = 8;
  const B = 16;
  const x = (i) => L + (i / Math.max(hist.length - 1, 1)) * (w - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  g.strokeStyle = '#ced5db';
  g.fillStyle = '#6d7882';
  g.font = '10px "Pretendard Variable", system-ui';
  g.lineWidth = 1;
  for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) {
    g.beginPath();
    g.moveTo(L, y(v));
    g.lineTo(w - R, y(v));
    g.stroke();
    g.fillText(v.toFixed(1), 2, y(v) + 3);
  }
  // 90% 구간 띠
  const band = hist.map((p, i) => [i, p.lower, p.upper]).filter((b) => Number.isFinite(b[1]) && Number.isFinite(b[2]));
  if (band.length > 1) {
    g.fillStyle = 'rgba(37, 110, 244, 0.16)';
    g.beginPath();
    band.forEach(([i, l]) => g.lineTo(x(i), y(l)));
    [...band].reverse().forEach(([i, , u]) => g.lineTo(x(i), y(u)));
    g.closePath();
    g.fill();
  }
  // 알람 기준선
  g.setLineDash([4, 3]);
  for (const [t, c] of [[info.warn, '#d7ab00'], [info.critical, '#d84b4b']]) {
    if (Number.isFinite(t) && t > lo && t < hi) {
      g.strokeStyle = c;
      g.beginPath();
      g.moveTo(L, y(t));
      g.lineTo(w - R, y(t));
      g.stroke();
    }
  }
  g.setLineDash([]);
  // 값 선
  g.strokeStyle = '#0d47a1';
  g.lineWidth = 1.6;
  g.beginPath();
  let started = false;
  hist.forEach((p, i) => {
    if (!Number.isFinite(p.value)) {
      started = false;
      return;
    }
    if (!started) g.moveTo(x(i), y(p.value));
    else g.lineTo(x(i), y(p.value));
    started = true;
  });
  g.stroke();
  g.fillStyle = '#6d7882';
  g.fillText('2분 전', L, h - 3);
  g.fillText('지금', w - R - 22, h - 3);
}
