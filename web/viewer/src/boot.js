// 첫 로딩 화면 (docs/27 7장). 단계별 진행을 보이고, 장면이 준비되면 부드럽게 사라진다.
// 진행률 계산(bootProgress)은 화면과 분리해 시험할 수 있게 순수 함수로 둔다.

export const STEPS = [
  { id: 'data', label: '화면 준비', weight: 10 },
  { id: 'model', label: '건물 모델', weight: 70 },
  { id: 'flow', label: '기류 데이터', weight: 20 },
];

// states: { data: 0~1 | 'done' | 'skip', ... } → 전체 진행률 0~1. 건너뜀(skip)과 끝남(done)은 1로 센다.
export function bootProgress(states, steps = STEPS) {
  const total = steps.reduce((a, s) => a + s.weight, 0);
  let sum = 0;
  for (const s of steps) {
    const v = states[s.id];
    const f = v === 'done' || v === 'skip' ? 1 : Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
    sum += f * s.weight;
  }
  return sum / total;
}

// ProgressEvent → 0~1 또는 null(크기를 모를 때)
export function eventFraction(e) {
  return e && e.lengthComputable && e.total > 0 ? Math.min(e.loaded / e.total, 1) : null;
}

export class Boot {
  constructor(doc = document, reduced = false) {
    this.el = doc.getElementById('boot');
    this.bar = doc.getElementById('boot-bar');
    this.text = doc.getElementById('boot-text');
    this.list = doc.getElementById('boot-steps');
    this.actions = doc.getElementById('boot-actions');
    this.reduced = reduced;
    this.states = {};
    this.finished = false;
    this._render();
  }

  set(id, v) {
    if (this.finished) return;
    this.states[id] = v;
    this._render();
  }

  _render() {
    if (!this.el) return;
    const p = bootProgress(this.states);
    this.bar.style.setProperty('--p', `${Math.round(p * 100)}%`);
    this.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    const cur = STEPS.find((s) => !(this.states[s.id] === 'done' || this.states[s.id] === 'skip')) ?? null;
    this.text.textContent = cur ? `${cur.label} 불러오는 중… ${Math.round(p * 100)}%` : '거의 다 됐다';
    for (const li of this.list?.children ?? []) {
      const v = this.states[li.dataset.step];
      li.dataset.state = v === 'done' ? 'done' : v === 'skip' ? 'skip' : li.dataset.step === cur?.id ? 'now' : 'wait';
    }
  }

  // 장면이 준비되었다: 화면에서 치운다. 움직임 줄이기 설정이면 바로 치운다.
  done() {
    if (this.finished || !this.el) return;
    this.finished = true;
    document.body.removeAttribute('aria-busy');
    if (this.reduced) {
      this.el.hidden = true;
      return;
    }
    this.el.classList.add('leaving'); // 투명해지는 동안에도 아래 화면을 누를 수 있게 한다(pointer-events: none)
    setTimeout(() => (this.el.hidden = true), 350);
  }

  // 실패: 이유와 다시 시도 단추를 보인다. 화면에는 남겨 둔다.
  fail(message, { lowQuality = false } = {}) {
    if (!this.el) return;
    this.finished = true;
    this.el.classList.add('failed');
    this.text.textContent = message;
    this.actions.hidden = false;
    this.actions.querySelector('[data-act="low"]').hidden = !lowQuality;
    this.actions.querySelector('[data-act="retry"]').onclick = () => location.reload();
    this.actions.querySelector('[data-act="low"]').onclick = () => {
      const u = new URL(location.href);
      u.searchParams.set('q', 'low');
      location.href = u.toString();
    };
  }
}
