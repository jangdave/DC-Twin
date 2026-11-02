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

// ?scenario=fan_fault&t=60&live=ws://127.0.0.1:8080/ws
export function parseParams(search, scenarioIds) {
  const p = new URLSearchParams(search);
  const out = { scenario: null, t: 0, live: null, liveError: null, view: null, stage: null };
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
  const view = p.get('view');
  if (view === 'temp_in' || view === 'temp_out' || view === 'power') out.view = view;
  const stage = p.get('stage');
  if (stage === 'exterior' || stage === 'hall') out.stage = stage;
  return out;
}
