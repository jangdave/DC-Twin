// 주소 규칙 (docs/18 5.6, 5.7장).

// 라이브 주소는 로컬(127.0.0.1, localhost)의 ws://와 모든 wss://만 받는다(FR-63).
export function checkLiveUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: '주소 형식이 올바르지 않다' };
  }
  if (u.protocol === 'wss:') return { ok: true, url: u.href };
  if (u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return { ok: true, url: u.href };
  if (u.protocol === 'ws:') return { ok: false, reason: '암호화하지 않은 ws://는 이 컴퓨터(127.0.0.1, localhost)만 쓸 수 있다' };
  return { ok: false, reason: 'ws:// 또는 wss:// 주소만 쓸 수 있다' };
}

// 이 컴퓨터의 주소인가(127.0.0.1, localhost, ::1). 아니면 원격 서버로 표시하고, 주소 링크(?server=, ?live=)로 열 때는 먼저 묻는다(docs/30 M6).
export function isLocalUrl(text) {
  try {
    const h = new URL(text).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

// ?scenario=fan_fault&t=60&live=ws://127.0.0.1:8080/ws
export function parseParams(search, scenarioIds) {
  const p = new URLSearchParams(search);
  const out = { scenario: null, t: 0, live: null, liveError: null, view: null, stage: null, mode: null, models: true, server: null, sky: 'day', q: null, panel: 'default', fx: null };
  const sc = p.get('scenario');
  if (sc && scenarioIds.includes(sc)) out.scenario = sc;
  const t = Number(p.get('t'));
  if (p.has('t') && Number.isFinite(t) && t >= 0) out.t = t;
  const live = p.get('live');
  if (live) {
    const r = checkLiveUrl(live);
    if (r.ok) out.live = r.url;
    else out.liveError = r.reason;
  }
  const server = p.get('server');
  if (server) {
    const r = checkLiveUrl(server);
    if (r.ok) out.server = r.url;
    else out.liveError = r.reason;
  }
  if (p.get('panel') === 'open') out.panel = 'open'; // 시험용: 오른쪽 패널을 처음부터 펼친다(기본은 PC 폭에서 접힘)
  if (p.get('fx') === 'on' || p.get('fx') === 'off') out.fx = p.get('fx'); // 후처리를 강제로 켜거나 끈다(기본은 단계가 정하고 자동 시험 브라우저에서는 끔)
  const view = p.get('view');
  if (view === 'temp_in' || view === 'temp_out' || view === 'power') out.view = view;
  const stage = p.get('stage');
  if (stage === 'exterior' || stage === 'hall') out.stage = stage;
  const mode = p.get('mode');
  if (mode === 'rec' || mode === 'lib' || mode === 'sim') out.mode = mode;
  if (p.get('models') === '0') out.models = false;
  if (p.get('sky') === 'dusk') out.sky = 'dusk';
  if (['low', 'mid', 'high'].includes(p.get('q'))) out.q = p.get('q');
  return out;
}
