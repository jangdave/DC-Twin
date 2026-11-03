// 직접 시뮬레이션 조작 패널 (docs/21 4장). 값은 textContent로만 넣는다.
import { SCENARIOS } from './core.js';
import { describeControl } from './runner.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clock = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export class SimPanel {
  // handlers: { onFan(crac, ratio), onPower(target, scale), onReset(), onSelectedPower(rack, scale) }, pretty: 이름 변환 함수
  constructor(handlers, pretty) {
    this.h = handlers;
    this.pretty = pretty;
    this.fanInputs = new Map();
    this.rowInputs = new Map();
    this._logLen = -1;
  }

  build(cracs, rows) {
    const fans = $('sim-fans');
    fans.replaceChildren();
    for (const c of cracs) {
      const row = el('label', 'sim-row');
      const name = el('span', 'sim-name', this.pretty(c));
      const input = el('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '5';
      input.value = '100';
      input.setAttribute('aria-label', `${this.pretty(c)} 팬 속도`);
      const val = el('output', 'sim-val', '100%');
      input.addEventListener('input', () => {
        val.textContent = `${input.value}%`;
        this.h.onFan(c, Number(input.value) / 100);
      });
      row.append(name, input, val);
      fans.append(row);
      this.fanInputs.set(c, { input, val });
    }
    const rowBox = $('sim-rows');
    rowBox.replaceChildren();
    for (const r of rows) {
      const row = el('label', 'sim-row');
      const name = el('span', 'sim-name', `${r}번 줄`);
      const input = el('input');
      input.type = 'range';
      input.min = '0';
      input.max = '200';
      input.step = '10';
      input.value = '100';
      input.setAttribute('aria-label', `${r}번 줄 랙 전력 배수`);
      const val = el('output', 'sim-val', '100%');
      input.addEventListener('input', () => {
        val.textContent = `${input.value}%`;
        this.h.onPower(`row:${String(r).padStart(2, '0')}`, Number(input.value) / 100);
      });
      row.append(name, input, val);
      rowBox.append(row);
      this.rowInputs.set(r, { input, val });
    }
    $('sim-reset').addEventListener('click', () => this.h.onReset());
  }

  show(on) {
    $('sim-panel').hidden = !on;
  }

  setScenario(id) {
    const sc = SCENARIOS[id];
    $('sim-scenario-desc').textContent = sc ? sc.description : '';
  }

  // 시나리오가 값을 바꿨을 때 슬라이더가 따라가게 엔진 상태를 반영한다
  syncFromEngine(engine) {
    for (const [c, { input, val }] of this.fanInputs) {
      const v = Math.round(engine.fan[c] * 100);
      if (Number(input.value) !== v) input.value = String(v);
      val.textContent = `${v}%`;
    }
    for (const [r, { input, val }] of this.rowInputs) {
      const names = engine.racks.filter((x) => x.row === r).map((x) => x.name);
      const v = Math.round((names.reduce((a, n) => a + engine.powerScale[n], 0) / names.length) * 100);
      if (Number(input.value) !== v) input.value = String(Math.min(v, 200));
      val.textContent = `${v}%`;
    }
  }

  renderLog(log) {
    if (log.length === this._logLen) return;
    this._logLen = log.length;
    const ol = $('sim-log');
    ol.replaceChildren();
    $('sim-log-empty').hidden = log.length > 0;
    for (const e of [...log].reverse().slice(0, 30)) {
      const li = el('li');
      li.append(el('time', '', clock(e.t)), document.createTextNode(describeControl(e, this.pretty)));
      ol.append(li);
    }
  }

  // 선택한 랙의 전력(랙 하나만 바꾸기)
  setSelected(rack, engine) {
    const box = $('sim-selected');
    box.hidden = !rack || !rack.startsWith('rack');
    if (box.hidden) return;
    $('sim-selected-name').textContent = `${this.pretty(rack)} 전력`;
    const input = $('sim-selected-power');
    const v = Math.round(engine.powerScale[rack] * 100);
    input.value = String(Math.min(v, 300));
    $('sim-selected-val').textContent = `${v}%`;
    input.onchange = null;
    input.oninput = () => {
      $('sim-selected-val').textContent = `${input.value}%`;
      this.h.onSelectedPower(rack, Number(input.value) / 100);
    };
  }
}
