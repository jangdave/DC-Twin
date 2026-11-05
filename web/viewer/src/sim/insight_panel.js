// "에너지·용량" 탭과 "이상 대비" 탭의 화면 (docs/27 14장). 값은 textContent로만 넣는다.
import { SCENARIOS, SUPPLY_MAX, SUPPLY_MIN } from './core.js';
import { capacity, compare, responseFor, rowInlets, snapshot, supplyRoom } from './insight.js';
import { todayUsage } from '../daily.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : v.toFixed(d));
const sign = (v, d = 1) => (v === null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);

export class InsightPanel {
  // opts: { store, rackKeys, rowOf(key), warnIn, supplyWarn, pretty, onSupply(v), onScenario(id) }
  constructor(opts) {
    this.o = opts;
    this.base = null; // { snap, scenario, at }
    this.refs = {};
    this._buildEnergy();
    this._buildPrep();
  }

  // ---- 에너지·용량 탭 ----
  _buildEnergy() {
    const root = $('pane-energy');
    root.replaceChildren();
    const r = this.refs;
    root.append(el('h2', '', '에너지'));
    const dl = el('dl', 'kv');
    for (const [k, label] of [['it', 'IT 전력'], ['cooling', '냉각 전력'], ['facility', '설비 전력'], ['pue', 'PUE'], ['kwh', '오늘 사용량(더미)'], ['maxIn', '가장 높은 입구 온도']]) {
      dl.append(el('dt', '', label));
      r[k] = el('dd', '', '–');
      dl.append(r[k]);
    }
    root.append(dl);
    // 하루 사용량 막대(더미 데이터): 시간마다 한 칸, 지금 시각은 강조, 아직 안 온 시간은 옅게(예상)
    r.day = el('div', 'day-chart');
    r.day.setAttribute('role', 'img');
    r.dayBars = [];
    for (let h = 0; h < 24; h++) {
      const b = el('i');
      r.day.append(b);
      r.dayBars.push(b);
    }
    root.append(r.day);
    const ax = el('div', 'day-axis');
    for (const t of ['0시', '6시', '12시', '18시', '24시']) ax.append(el('span', '', t));
    root.append(ax);
    r.dayNote = el('p', 'muted small', '');
    root.append(r.dayNote);

    root.append(el('h3', '', '기준과 비교'));
    const bar = el('div', 'btn-row');
    r.save = el('button', '', '지금을 기준으로 저장');
    r.clear = el('button', '', '기준 지우기');
    r.split = el('button', '', '화면 나눠 비교');
    r.split.title = '3D 화면을 반으로 나눠 왼쪽은 저장한 기준, 오른쪽은 지금 상태를 같은 각도로 보여 줍니다(랙 색 기준).';
    r.save.type = r.clear.type = r.split.type = 'button';
    r.clear.hidden = true;
    r.split.hidden = true;
    r.split.setAttribute('aria-pressed', 'false');
    r.split.addEventListener('click', () => this.o.onSplit?.(r.split.getAttribute('aria-pressed') !== 'true'));
    r.save.addEventListener('click', () => this.saveBase());
    r.clear.addEventListener('click', () => this.clearBase());
    bar.append(r.save, r.clear, r.split);
    root.append(bar);
    r.cmp = el('div', 'cmp');
    root.append(r.cmp);

    root.append(el('h3', '', '공급 온도 (냉각 설정)'));
    r.supplyBox = el('div', 'supply');
    const row = el('label', 'sim-row sim-supply');
    r.supplyRow = row;
    row.append(el('span', 'sim-name', '공급 온도'));
    r.supply = el('input');
    r.supply.type = 'range';
    r.supply.min = String(SUPPLY_MIN);
    r.supply.max = String(SUPPLY_MAX);
    r.supply.step = '0.5';
    r.supply.value = '18';
    r.supply.setAttribute('aria-label', '공급 온도');
    r.supplyVal = el('output', 'sim-val', '18.0 °C');
    r.supply.addEventListener('input', () => {
      r.supplyVal.textContent = `${Number(r.supply.value).toFixed(1)} °C`;
      this.o.onSupply(Number(r.supply.value));
    });
    row.append(r.supply, r.supplyVal);
    r.supplyBox.append(row);
    r.room = el('p', 'muted', '');
    r.supplyBox.append(r.room);
    r.supplyBox.append(el('p', 'muted small', '가정: 공급 온도를 1 °C 올리면 냉각 전력이 약 3% 줄고(실측값이 아닌 가정값), 입구 온도는 같은 폭으로 오른다. 줄어드는 방향을 보는 용도이며 실제 절감량이 아니다.'));
    root.append(r.supplyBox);

    root.append(el('h3', '', '용량 (랙별 여유 전력)'));
    r.capSum = el('p', '', '');
    root.append(r.capSum);
    r.capList = el('ol', 'caplist');
    root.append(r.capList);
    root.append(el('h3', '', '줄별 입구 온도 여유'));
    r.rows = el('ul', 'rowlist');
    root.append(r.rows);
    this.refs.ratedNote = el('p', 'muted small', '');
    root.append(this.refs.ratedNote);
    root.append(el('p', 'muted small', `"과냉각 의심"은 가장 높은 입구 온도가 주의 기준보다 6 °C 이상 낮은 줄이며, 간이 모델 기준의 힌트다.`));
  }

  // ---- 이상 대비 탭 ----
  _buildPrep() {
    const root = $('pane-prep');
    root.replaceChildren();
    const r = this.refs;
    root.append(el('h2', '', '이상 대비'));
    root.append(el('p', 'muted', '이상 상황을 일으키고, 대응하고, 기준과 비교해 본다. 가상 시설의 예시이며 실제 운영 절차가 아니다.'));
    r.scBtns = el('div', 'btn-row wrap');
    this.scButtons = new Map();
    for (const [id, s] of Object.entries(SCENARIOS)) {
      const b = el('button', '', s.title);
      b.type = 'button';
      b.addEventListener('click', () => this.o.onScenario(id));
      r.scBtns.append(b);
      this.scButtons.set(id, b);
    }
    root.append(r.scBtns);
    r.scDesc = el('p', 'muted', '');
    root.append(r.scDesc);
    root.append(el('h3', '', '대응 순서'));
    r.steps = el('ol', 'steps');
    root.append(r.steps);
    root.append(el('h3', '', '기준과 비교'));
    r.prepCmp = el('div', 'cmp');
    root.append(r.prepCmp);
  }

  saveBase() {
    this.base = { snap: snapshot(this.o.store, this.o.rackKeys, this.o.warnIn), scenario: this._scenario };
    this.refs.clear.hidden = false;
    this.refs.split.hidden = false;
    this.o.onBase?.(true);
    this._renderCmp(snapshot(this.o.store, this.o.rackKeys, this.o.warnIn));
  }

  clearBase() {
    this.base = null;
    this.refs.clear.hidden = true;
    this.refs.split.hidden = true;
    this.syncSplit(false);
    this.o.onBase?.(false);
    this._renderCmp(snapshot(this.o.store, this.o.rackKeys, this.o.warnIn));
  }

  // 화면 나눠 비교 단추의 눌림 표시(바깥에서 끝났을 때도 맞춘다)
  syncSplit(on) {
    this.refs.split.setAttribute('aria-pressed', String(on));
    this.refs.split.textContent = on ? '나눠 비교 끄기' : '화면 나눠 비교';
  }

  _renderCmp(now) {
    for (const box of [this.refs.cmp, this.refs.prepCmp]) {
      box.replaceChildren();
      if (!this.base) {
        box.append(el('p', 'muted', '아직 기준이 없다. "지금을 기준으로 저장"을 누른 뒤 시나리오나 슬라이더를 바꾸면 차이가 보인다.'));
        continue;
      }
      const head = el('div', 'cmp-row cmp-head');
      for (const t of ['항목', '기준', '지금', '차이']) head.append(el('span', '', t));
      box.append(head);
      for (const c of compare(this.base.snap, now)) {
        const row = el('div', 'cmp-row');
        row.append(el('span', '', c.label), el('span', 'num', c.base === null ? '–' : `${fmt(c.base, c.digits)}${c.unit ? ` ${c.unit}` : ''}`), el('span', 'num', c.now === null ? '–' : `${fmt(c.now, c.digits)}${c.unit ? ` ${c.unit}` : ''}`));
        const d = el('span', `num delta ${c.good === null ? '' : c.good ? 'good' : 'bad'}`, c.delta === null ? '–' : c.dir === 'same' ? '변화 없음' : `${sign(c.delta, c.digits)}${c.pct !== null && c.key !== 'alarms' ? ` (${sign(c.pct, 1)}%)` : ''}`);
        row.append(d);
        box.append(row);
      }
      box.append(el('p', 'muted small', `기준: ${SCENARIOS[this.base.scenario]?.title ?? '직접 조작'}에서 저장. 줄어드는 방향을 보는 값이며 실제 절감량이 아니다.`));
    }
  }

  // 오늘 사용량(더미 데이터): 시계 기준이라 창을 닫아 둬도 이어서 늘어난다
  _renderDay() {
    const r = this.refs;
    const u = todayUsage();
    r.kwh.textContent = `${Math.round(u.kwh).toLocaleString('ko-KR')} kWh`;
    const h = Math.floor(u.hour);
    if (this._dayHour !== h) {
      this._dayHour = h;
      const lo = Math.min(...u.profile), hi = Math.max(...u.profile);
      u.profile.forEach((v, i) => {
        const b = r.dayBars[i];
        b.style.height = `${28 + (72 * (v - lo)) / Math.max(hi - lo, 1)}%`;
        b.className = i === h ? 'now' : i > h ? 'future' : '';
        b.title = `${i}시 ${Math.round(v)} kW${i > h ? ' (예상)' : ''}`;
      });
      r.day.setAttribute('aria-label', `오늘 시간별 전력(더미 데이터). 지금 ${h}시`);
      r.dayNote.textContent = `하루 전체 약 ${Math.round(u.total).toLocaleString('ko-KR')} kWh(더미 데이터). 진한 칸은 지난 시간, 옅은 칸은 예상, 강조는 지금이다. 실제 측정값이 아니다.`;
    }
  }

  // engine: 직접 시뮬레이션 엔진(없으면 서버 모드), scenario: 지금 시나리오 이름
  // kind: 'sim'(브라우저 간이 계산) | 'lib'(미리 계산한 값) | 'live'(서버). 서버와 미리 계산한 값에서는 engine이 없다.
  render(engine, scenario, kind = 'sim', supplyNow = null) {
    this._scenario = scenario;
    const r = this.refs;
    const now = snapshot(this.o.store, this.o.rackKeys, this.o.warnIn);
    r.it.textContent = now.it === null ? '–' : `${fmt(now.it)} kW`;
    r.cooling.textContent = now.cooling === null ? '–' : `${fmt(now.cooling)} kW`;
    r.facility.textContent = now.facility === null ? '–' : `${fmt(now.facility)} kW`;
    r.pue.textContent = fmt(now.pue, 2);
    this._renderDay();
    r.maxIn.textContent = now.maxIn === null ? '–' : `${fmt(now.maxIn)} °C (${this.o.pretty(now.maxRack)})`;
    this._renderCmp(now);

    const lib = kind === 'lib';
    // 급기 온도 값: 간이 계산은 엔진에서, 서버는 서버가 알려 준 값(supplyNow)에서 읽는다. 미리 계산한 값에는 없다(슬라이더 대신 안내).
    const cur = engine ? engine.cfg.t_supply : Number.isFinite(supplyNow) ? supplyNow : null;
    r.supplyBox.hidden = cur === null && !lib;
    r.supplyRow.hidden = cur === null;
    if (cur !== null && document.activeElement !== r.supply) {
      r.supply.value = String(cur);
      r.supplyVal.textContent = `${cur.toFixed(1)} °C`;
    }
    const supplyWarn = this.o.supplyWarn ?? null; // 냉각 장치 공급 온도 센서의 주의 기준
    let room = supplyRoom(now.maxIn, this.o.warnIn);
    if (room !== null && supplyWarn !== null && cur !== null) room = Math.min(room, Math.max(0, supplyWarn - cur));
    const over = supplyWarn !== null && cur !== null && cur > supplyWarn;
    if (lib) {
      r.room.textContent = '급기 온도와 부하는 위쪽 "시나리오" 목록의 "급기 온도", "부하" 항목에서 미리 계산한 값을 골라 비교한다. 직접 바꿔 계산하려면 서버에 연결하거나 간이 계산을 쓴다.';
    } else r.room.textContent = over ? `공급 온도 ${cur.toFixed(1)} °C가 냉각 장치 공급 온도 주의 기준(${supplyWarn} °C)을 넘어 냉각 장치마다 알람이 난다. 입구 온도는 아직 여유가 있어도 이 기준이 먼저 걸린다.` : room === null ? '' : room > 0.4 ? `가장 높은 입구 온도가 주의 기준(${this.o.warnIn} °C)보다 ${fmt(now.margin)} °C 낮다. 공급 온도를 약 ${fmt(room)} °C까지 올려 볼 여유가 있다(모델 기준).` : `입구 온도 여유가 ${fmt(now.margin)} °C뿐이라 공급 온도를 더 올릴 여유가 없다.`;

    const cap = capacity(this.o.store, this.o.rackKeys, this.o.rated);
    r.capSum.textContent = cap.racks.length ? `남은 전력 합계 ${fmt(cap.totalHeadroom)} kW. 정격의 90% 이상인 랙 ${cap.near}기${cap.over ? `, 정격 초과 ${cap.over}기` : ''}.` : '랙 전력 값이 아직 없다.';
    r.ratedNote.textContent = `랙 정격 전력은 ${cap.rated} kW로 본다(센서 정의의 전력 주의 기준).`;
    r.capList.replaceChildren();
    for (const c of cap.racks.slice(0, 5)) {
      const li = el('li', c.pct > 100 ? 'bad' : c.pct >= 90 ? 'warn' : '');
      li.append(el('span', '', this.o.pretty(c.key)), el('span', 'num', `${fmt(c.kw)} / ${cap.rated} kW`), el('span', 'num', `여유 ${fmt(c.headroom)} kW`));
      r.capList.append(li);
    }
    r.rows.replaceChildren();
    for (const row of rowInlets(this.o.store, this.o.rackKeys, this.o.rowOf, this.o.warnIn)) {
      const li = el('li', row.overcooled ? 'over' : '');
      li.append(el('span', '', `${row.row}번 줄`), el('span', 'num', `최고 ${fmt(row.max)} °C`), el('span', 'num', `여유 ${fmt(row.margin)} °C`));
      if (row.overcooled) li.append(el('span', 'chip-over', '과냉각 의심'));
      r.rows.append(li);
    }

    // 이상 대비 탭
    for (const [id, b] of this.scButtons) b.classList.toggle('on', id === scenario);
    const sc = SCENARIOS[scenario];
    r.scDesc.textContent = sc ? sc.description : '';
    if (this._stepsFor !== scenario) {
      this._stepsFor = scenario;
      r.steps.replaceChildren(...responseFor(scenario).steps.map((t) => el('li', '', t)));
    }
  }
}
