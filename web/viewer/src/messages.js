// 게이트웨이 WebSocket 메시지 검사 (docs/11 4.3장, docs/18 4.4장).
// 형식이 맞는 것만 통과시킨다. 틀린 메시지는 null을 돌려주고 호출한 쪽이 개수를 센다.

const QUALITY = new Set(['good', 'bad', 'stale']);
const ALARM = new Set(['normal', 'warn', 'critical']);
const CONFIDENCE = new Set(['ok', 'caution', 'low', 'fallback']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : null);

export function parseSample(m) {
  const sensorId = str(m.sensorId);
  if (!sensorId) return null;
  const quality = QUALITY.has(m.quality) ? m.quality : 'good';
  const out = { sensorId, value: num(m.value), quality, ts: str(m.ts) };
  const lower = num(m.lower);
  const upper = num(m.upper);
  if (lower !== null && upper !== null && lower <= upper) {
    out.lower = lower;
    out.upper = upper;
  }
  if (CONFIDENCE.has(m.confidence)) out.confidence = m.confidence;
  return out;
}

// 반환: { kind: 'snapshot'|'sample'|'alarm'|'scenario'|'aggregate', ... } 또는 null
export function parseMessage(raw) {
  let m = raw;
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.type) {
    case 'sample': {
      const s = parseSample(m);
      return s ? { kind: 'sample', ...s } : null;
    }
    case 'alarm': {
      const sensorId = str(m.sensorId);
      if (!sensorId || !ALARM.has(m.from) || !ALARM.has(m.to)) return null;
      return { kind: 'alarm', sensorId, from: m.from, to: m.to, value: num(m.value), ts: str(m.ts) };
    }
    case 'scenario': {
      const name = str(m.name);
      if (!name || (m.event !== 'start' && m.event !== 'end' && m.event !== 'event')) return null;
      const out = { kind: 'scenario', name, event: m.event, ts: str(m.ts) };
      if (m.event === 'event' && ['crac_fan', 'rack_power_scale', 'supply_temp'].includes(m.kind) && str(m.target) && num(m.value) !== null) {
        out.info = { kind: m.kind, target: m.target, value: m.value };
        if (num(m.t) !== null) out.t = m.t;
      }
      return out;
    }
    case 'error': {
      const message = str(m.message);
      return message ? { kind: 'error', message } : null;
    }
    case 'aggregate': {
      const name = str(m.name);
      if (!name) return null;
      return { kind: 'aggregate', name, value: num(m.value), ts: str(m.ts) };
    }
    case 'snapshot': {
      if (!Array.isArray(m.sensors)) return null;
      const sensors = [];
      for (const s of m.sensors) {
        if (!s || typeof s !== 'object') continue;
        const p = parseSample(s);
        if (!p) continue;
        sensors.push({ ...p, alarm: ALARM.has(s.alarm) ? s.alarm : 'normal' });
      }
      const aggregates = {};
      const src = m.aggregates;
      const list = Array.isArray(src) ? src : src && typeof src === 'object' ? Object.values(src) : [];
      for (const a of list) {
        if (a && str(a.name)) aggregates[a.name] = num(a.value);
      }
      const scenario = typeof m.scenario === 'string' ? str(m.scenario) : m.scenario && typeof m.scenario === 'object' ? str(m.scenario.name) : null;
      let controls = null;
      const c = m.controls;
      if (c && typeof c === 'object' && c.fan && c.powerScale) {
        const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => /^(rack|crac)_\d+$/.test(k) && num(v) !== null));
        controls = { fan: clean(c.fan), powerScale: clean(c.powerScale), supply: num(c.supply) }; // supply: 서버가 알려 주는 급기 온도(없으면 null)
      }
      return { kind: 'snapshot', ts: str(m.ts), scenario, sensors, aggregates, controls };
    }
    default:
      return null;
  }
}
