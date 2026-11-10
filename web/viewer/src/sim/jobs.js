// 서버 시뮬레이션 작업 (docs/31 3~5장). 조건을 정해 서버(Omniverse Kit 안의 로컬 서버)에 보내고, 진행률과 남은 시간을 받고,
// 끝나면 결과 녹화를 받는다. 메시지 형식은 server/README.md "Omniverse Kit 안에서 띄우기와 시뮬레이션 작업".
// DOM을 모른다(시험할 수 있게). 화면은 jobs_ui.js가 맡는다.

export const DURATION_RANGE = [60, 1800];
export const SUPPLY_RANGE = [14, 27];
export const ROW_POWER_RANGE = [0.5, 1.5]; // 화면 슬라이더(서버는 0~3까지 받는다)

// 화면 입력값 -> 서버 조건. 기본값과 같은 값은 빼서 같은 조건이면 같은 결과(서버가 다시 계산하지 않음)가 되게 한다.
// v: { duration, supply, precise, fans: {crac_01: 0~1}, off: {crac_01: bool}, rows: {1: 배수}, failure: { crac, t } | null }
export function conditionsFrom(v, cracs, rows) {
  const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, Number(x)));
  const duration = Math.round(clamp(v.duration ?? 300, DURATION_RANGE));
  const out = { duration, supply: Math.round(clamp(v.supply ?? 18, SUPPLY_RANGE) * 10) / 10, precise: v.precise !== false };
  const fans = {};
  for (const c of cracs) {
    const f = v.off?.[c] ? 0 : Math.round(clamp(v.fans?.[c] ?? 1, [0, 1]) * 100) / 100;
    if (f !== 1) fans[c] = f;
  }
  if (Object.keys(fans).length) out.fans = fans;
  const power = {};
  for (const r of rows) {
    const s = Math.round(clamp(v.rows?.[r] ?? 1, ROW_POWER_RANGE) * 100) / 100;
    if (s !== 1) power[`row:${String(r).padStart(2, '0')}`] = s;
  }
  if (Object.keys(power).length) out.power = power;
  const f = v.failure;
  if (f && cracs.includes(f.crac) && !v.off?.[f.crac]) {
    out.failures = [{ crac: f.crac, t: Math.round(clamp(f.t ?? 60, [0, duration - 1])) }];
  }
  return out;
}

// 남은 시간 문장(초 -> "약 12분", "40초"). 모르면 "계산 중".
export function formatEta(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '남은 시간 계산 중';
  if (s < 1) return '곧 끝남';
  if (s < 90) return `약 ${Math.round(s)}초 남음`;
  const m = Math.round(s / 60);
  return m < 90 ? `약 ${m}분 남음` : `약 ${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
}

// 조건 한 줄 요약(진행 창과 결과 제목에 씀)
export function summarize(c) {
  const parts = [`${c.duration}초`, `급기 ${c.supply}°C`];
  const off = Object.entries(c.fans ?? {}).filter(([, v]) => v === 0).map(([k]) => k.toUpperCase());
  const slow = Object.entries(c.fans ?? {}).filter(([, v]) => v > 0 && v < 1).map(([k, v]) => `${k.toUpperCase()} ${Math.round(v * 100)}%`); // 서버는 모든 공조기 값을 돌려주므로 100%는 뺀다
  if (off.length) parts.push(`${off.join(', ')} 꺼짐`);
  if (slow.length) parts.push(slow.join(', '));
  for (const f of c.failures ?? []) parts.push(`${f.t}초에 ${f.crac.toUpperCase()} 고장`);
  const p = Object.entries(c.power ?? {}).filter(([, v]) => v !== 1).map(([k, v]) => `${k.replace('row:', '')}줄 ${Math.round(v * 100)}%`);
  if (p.length) parts.push(`부하 ${p.join(', ')}`);
  parts.push(c.precise ? '정확(OpenFOAM 흐름)' : '빠름(보정 모델)');
  return parts.join(' · ');
}

// 작업 전용 연결. 실시간 값 연결(LiveClient)과 따로 둔다: 메뉴를 바꿔 실시간 연결이 닫혀도 작업 진행은 계속 받아야 한다.
export class JobClient {
  // url: ws://..., token: 접근 토큰(선택), onJob(job), onResult(id, rec), onError(message), onState(state)
  constructor(url, { token = null, WebSocketImpl = globalThis.WebSocket, onJob = () => {}, onResult = () => {}, onError = () => {}, onState = () => {} } = {}) {
    this.url = url;
    this.token = token;
    this.WS = WebSocketImpl;
    this.on = { onJob, onResult, onError, onState };
    this.state = 'idle';
    this.jobs = new Map(); // id -> 마지막 상태
    this._pending = []; // 연결 전에 보낸 요청
  }

  start() {
    this._stopped = false;
    const ws = new this.WS(this.url);
    this.ws = ws;
    this._set('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.token) ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      this._set('open');
      for (const m of this._pending.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw.includes('"job') && !raw.includes('"error"')) return; // 실시간 값(sample 등)은 이 연결에서 쓰지 않는다
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === 'job' && m.job?.id) {
        this.jobs.set(m.job.id, m.job);
        this.on.onJob(m.job);
      } else if (m.type === 'job_result' && m.rec) this.on.onResult(m.id, m.rec);
      else if (m.type === 'error') this.on.onError(String(m.message ?? '서버 오류'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._set(this._stopped ? 'idle' : 'closed');
    };
    ws.onerror = () => {};
  }

  stop() {
    this._stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* 이미 닫힘 */
    }
    this._set('idle');
  }

  _set(s) {
    this.state = s;
    this.on.onState(s);
  }

  _send(m) {
    if (this.state === 'open') this.ws.send(JSON.stringify(m));
    else this._pending.push(m);
  }

  submit(conditions) {
    this._send({ type: 'job', action: 'submit', conditions });
  }

  cancel(id) {
    this._send({ type: 'job', action: 'cancel', id });
  }

  result(id) {
    this._send({ type: 'job', action: 'result', id });
  }
}
