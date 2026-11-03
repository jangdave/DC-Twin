// 화면 조각들(상단 집계, 상세 패널, 알람 목록, 시간 막대, 범례, 추이 그래프). 값은 textContent로만 넣는다(6.4장).
import { ALARM_LABEL, CONFIDENCE_HELP, CONFIDENCE_LABEL, barFraction, confidenceColor, tempColor, toCss } from './colors.js';
import { VIEWS } from './scene.js';

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
    this.h = handlers; // { onSelect(eq), onView(v), onScenario(id), onPlay(), onSpeed(x), onSeek(t), onLoop(b), onPreset(p), onLabels(b), onBackToRec(), onEnter(), onBack(), onMode(m), onModels(on), onFlow(on), onSky(name), onServer(url) }
    this.metricTab = null;
    this.selected = null;
    this._lastAlarmCount = -1;
    this._lastDetailKey = '';
    this.bind();
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
    $('flow-btn').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      this.h.onFlow(on);
    });
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
    $('help-btn').addEventListener('click', () => $('help-dialog').showModal());
    $('live-back').addEventListener('click', () => this.h.onBackToRec());
    $('enter-btn').addEventListener('click', () => this.h.onEnter());
    $('back-btn').addEventListener('click', () => this.h.onBack());
    $('sc-max').addEventListener('click', (e) => e.currentTarget.dataset.rack && this.h.onSelect(e.currentTarget.dataset.rack, true));
    document.querySelectorAll('#mode-group [data-mode]').forEach((b) => b.addEventListener('click', () => (b.dataset.mode === 'server' ? this.openServerDialog() : this.h.onMode(b.dataset.mode))));
    $('server-connect').addEventListener('click', () => {
      const r = this.h.onServer($('server-url').value.trim());
      $('server-error').hidden = r === true;
      if (r !== true) $('server-error').textContent = r;
      else $('server-dialog').close();
    });
    $('server-url').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('server-connect').click()));
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
  setScenarios(list, current) {
    const sel = $('scenario-select');
    sel.replaceChildren();
    for (const s of list) {
      const o = el('option', '', s.title);
      o.value = s.id;
      o.title = s.note;
      sel.append(o);
    }
    sel.value = current;
  }

  setMode(mode, text) {
    const b = $('mode-badge');
    b.className = `badge ${mode}`;
    b.textContent = text;
    const own = mode === 'rec' || mode === 'sim'; // 이 화면이 재생이나 계산을 직접 하는 방식(라이브가 아님)
    $('transport').hidden = !own;
    $('live-info').hidden = own;
    $('scenario-select').disabled = !own;
    $('timebar').hidden = mode === 'sim';
    $('loop-label').hidden = mode === 'sim';
    document.querySelectorAll('#mode-group [data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  }

  openServerDialog() {
    $('server-error').hidden = true;
    $('server-dialog').showModal();
    $('server-url').focus();
  }

  // 서버에 조작을 보내는 모드: 시나리오 선택을 열고 "로컬 서버" 단추를 강조한다
  setControlMode(on) {
    $('scenario-select').disabled = !on;
    document.querySelectorAll('#mode-group [data-mode]').forEach((x) => x.classList.toggle('on', on && x.dataset.mode === 'server'));
  }

  setLiveText(t) {
    $('live-text').textContent = t;
  }

  // 외관과 홀에 따라 보일 조각을 바꾼다
  setStage(stage) {
    const ext = stage === 'exterior';
    $('exterior-card').hidden = !ext;
    $('stage-tools').hidden = ext;
    $('back-btn').hidden = ext;
    $('stage').dataset.stage = stage;
    $('canvas').setAttribute('aria-label', ext ? '데이터센터 건물 외관. 건물을 누르거나 Enter를 누르면 안으로 들어간다' : '데이터센터 3D 장면. 방향키로 랙을 선택할 수 있다');
    if (ext) $('enter-btn').focus({ preventScroll: true });
  }

  renderExterior(s) {
    const none = '데이터 없음';
    $('ext-alarms').textContent = s.hasData ? `${s.alarms}건` : none;
    $('ext-temp').textContent = s.maxTempIn === null ? none : `${fmt(s.maxTempIn, 1)} °C`;
    $('ext-it').textContent = s.itPower === null ? none : `${fmt(s.itPower, 1)} kW`;
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
    if (log.length === this._lastAlarmCount && this._lastAlarmKey === log.at(-1)) return;
    this._lastAlarmCount = log.length;
    this._lastAlarmKey = log.at(-1);
    const list = $('alarm-list');
    list.replaceChildren();
    $('alarm-empty').hidden = log.length > 0;
    $('alarm-count').textContent = log.length ? `(${log.length}건)` : '';
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
    g.fillStyle = '#9aa5b4';
    g.font = '12px system-ui';
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
  g.strokeStyle = '#2a3340';
  g.fillStyle = '#9aa5b4';
  g.font = '10px system-ui';
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
    g.fillStyle = 'rgba(79, 216, 255, 0.18)';
    g.beginPath();
    band.forEach(([i, l]) => g.lineTo(x(i), y(l)));
    [...band].reverse().forEach(([i, , u]) => g.lineTo(x(i), y(u)));
    g.closePath();
    g.fill();
  }
  // 알람 기준선
  g.setLineDash([4, 3]);
  for (const [t, c] of [[info.warn, '#ffcc00'], [info.critical, '#ff2619']]) {
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
  g.strokeStyle = '#e6eaf0';
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
  g.fillStyle = '#9aa5b4';
  g.fillText('2분 전', L, h - 3);
  g.fillText('지금', w - R - 22, h - 3);
}
