// 서버 시뮬레이션 작업의 화면 조각: 조건 창(#job-dialog)과 진행 창(#job-progress). 값과 연결은 jobs.js, 연결 관리는 main.js.
import { conditionsFrom, formatEta, summarize } from './jobs.js';

const $ = (id) => document.getElementById(id);
const STATE_TEXT = { queued: '대기 중', running: '계산 중', done: '끝남', failed: '실패', cancelled: '취소됨' };

export class JobUI {
  // h: { onSubmit(conditions), onCancel(id), onView(id) }
  constructor(h) {
    this.h = h;
    this.cracs = [];
    this.rows = [];
    this.current = null; // 진행 창이 보여 주는 작업
    $('job-cta-btn').addEventListener('click', () => this.open());
    $('job-submit').addEventListener('click', () => this._submit());
    $('job-form').addEventListener('input', () => this._summary());
    $('job-p-close').addEventListener('click', () => ($('job-progress').hidden = true));
    $('job-p-cancel').addEventListener('click', () => this.current && this.h.onCancel(this.current.id));
    $('job-p-view').addEventListener('click', () => this.current && this.h.onView(this.current.id));
  }

  // cracs: ['crac_01', ...], rows: [1, 2, ...]
  build(cracs, rows) {
    this.cracs = cracs;
    this.rows = rows;
    $('job-cracs').replaceChildren(
      ...cracs.map((c) => {
        const row = document.createElement('div');
        row.className = 'job-crac';
        const name = c.toUpperCase();
        row.innerHTML = `<label class="check"><input type="checkbox" data-on="${c}" checked /> ${name}</label>
          <input type="range" min="0" max="100" step="5" value="100" data-fan="${c}" aria-label="${name} 팬 속도(%)" />
          <output data-fan-out="${c}">100%</output>`;
        return row;
      }),
    );
    $('job-rows').replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement('label');
        row.className = 'job-row';
        row.innerHTML = `${r}줄 <input type="range" min="50" max="150" step="5" value="100" data-row="${r}" aria-label="${r}줄 부하(%)" /> <output data-row-out="${r}">100%</output>`;
        return row;
      }),
    );
    const sel = $('job-fail-crac');
    sel.replaceChildren(new Option('없음', ''), ...cracs.map((c) => new Option(c.toUpperCase(), c)));
    this._summary();
  }

  // 서버가 작업을 받을 수 있을 때만 단추를 보인다
  setAvailable(on) {
    $('job-cta').hidden = !on;
    if (!on && $('job-dialog').open) $('job-dialog').close();
  }

  open() {
    $('job-error').hidden = true;
    this._summary();
    $('job-dialog').showModal();
  }

  values() {
    const v = { duration: Number($('job-duration').value), supply: Number($('job-supply').value), precise: $('job-precise').checked, fans: {}, off: {}, rows: {} };
    document.querySelectorAll('#job-cracs [data-fan]').forEach((el) => (v.fans[el.dataset.fan] = Number(el.value) / 100));
    document.querySelectorAll('#job-cracs [data-on]').forEach((el) => (v.off[el.dataset.on] = !el.checked));
    document.querySelectorAll('#job-rows [data-row]').forEach((el) => (v.rows[el.dataset.row] = Number(el.value) / 100));
    const fc = $('job-fail-crac').value;
    v.failure = fc ? { crac: fc, t: Number($('job-fail-t').value) } : null;
    return v;
  }

  conditions() {
    return conditionsFrom(this.values(), this.cracs, this.rows);
  }

  _summary() {
    document.querySelectorAll('#job-cracs [data-fan]').forEach((el) => {
      const out = document.querySelector(`[data-fan-out="${el.dataset.fan}"]`);
      const on = document.querySelector(`[data-on="${el.dataset.fan}"]`)?.checked;
      el.disabled = !on;
      if (out) out.textContent = on ? `${el.value}%` : '꺼짐';
    });
    document.querySelectorAll('#job-rows [data-row]').forEach((el) => {
      const out = document.querySelector(`[data-row-out="${el.dataset.row}"]`);
      if (out) out.textContent = `${el.value}%`;
    });
    if (this.cracs.length) $('job-summary').textContent = summarize(this.conditions());
  }

  _submit() {
    $('job-error').hidden = true;
    const c = this.conditions();
    this.h.onSubmit(c);
    $('job-dialog').close();
    this.render({ id: null, state: 'queued', progress: 0, etaS: null, conditions: c, stages: [], notes: [] });
  }

  setError(msg) {
    // 조건 창이 열려 있으면 거기에, 아니면 진행 창에 보인다
    if ($('job-dialog').open) {
      $('job-error').textContent = msg;
      $('job-error').hidden = false;
      return;
    }
    $('job-progress').hidden = false;
    $('job-p-stage').textContent = `서버가 거절함: ${msg}`;
  }

  // 작업 상태 하나를 진행 창에 그린다. 다른 작업의 알림이면(같은 조건을 다른 화면이 보낸 경우 등) 지금 작업이 없을 때만 따라간다.
  render(job) {
    if (this.current?.id && job.id && job.id !== this.current.id && ['queued', 'running'].includes(this.current.state)) return;
    this.current = job;
    const p = $('job-progress');
    p.hidden = false;
    const pct = Math.round((job.progress ?? 0) * 100);
    $('job-p-title').textContent = `서버 계산 · ${STATE_TEXT[job.state] ?? job.state}`;
    $('job-p-cond').textContent = job.conditions ? summarize(job.conditions) : '';
    const stages = job.stages ?? [];
    const i = stages.findIndex((s) => s.id === job.stage);
    $('job-p-stage').textContent =
      job.state === 'running' && i >= 0 ? `${i + 1}/${stages.length} 단계: ${job.stageTitle ?? job.stage}` : job.state === 'queued' ? (job.position ? `대기 ${job.position}번째` : '서버에 보내는 중') : job.state === 'failed' ? `실패: ${job.error ?? ''}` : job.cached ? '같은 조건의 결과가 있어 바로 끝남' : STATE_TEXT[job.state] ?? '';
    $('job-p-bar').style.width = `${pct}%`;
    p.querySelector('.job-bar').setAttribute('aria-valuenow', String(pct));
    $('job-p-eta').textContent = job.state === 'running' || job.state === 'queued' ? `${pct}% · ${formatEta(job.etaS)}` : `${pct}%`;
    const notes = job.notes ?? [];
    $('job-p-notes').hidden = !notes.length;
    $('job-p-notes').textContent = notes.join(' ');
    $('job-p-view').hidden = job.state !== 'done';
    $('job-p-cancel').hidden = !(job.state === 'running' || job.state === 'queued') || !job.id;
  }
}
