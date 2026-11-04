// 서버의 데이터 API(sim/sensors/dct_sensors/api.py) 클라이언트. 미리 계산한 값을 서버에서 받아 쓴다.
// 서버가 없거나 응답이 이상하면 호출한 쪽이 사이트에 포함된 정적 파일(data/)로 돌아간다(대체 경로).
//   GET /api/meta, /api/library, /api/library/<id>

// 서버 연결 주소(ws://host:port/ws)에서 데이터 API의 기본 주소(http://host:port)를 만든다. 형식이 틀리면 null.
export function apiBaseFromWs(wsUrl) {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:' && u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol === 'wss:' || u.protocol === 'https:' ? 'https' : 'http'}://${u.host}`;
  } catch {
    return null;
  }
}

const ID_RE = /^[a-z0-9_]{1,40}$/;

// 목록 응답 검사. 틀리면 이유와 함께 오류를 던진다(받은 목록을 쓰지 않고 정적 파일로 돌아가게).
export function parseLibrary(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.index) || d.index.length === 0) throw new Error('라이브러리 목록이 올바르지 않다');
  for (const it of d.index) {
    if (!it || !ID_RE.test(it.id) || typeof it.title !== 'string' || !Number.isInteger(it.n) || it.n < 1) throw new Error(`라이브러리 항목이 올바르지 않다: ${it?.id}`);
    if (it.file !== undefined && !ID_RE.test(it.file)) throw new Error(`라이브러리 항목의 파일 이름이 올바르지 않다: ${it.id}`);
  }
  const ids = new Set(d.index.map((i) => i.id));
  for (const it of d.index) if (it.file && !ids.has(it.file)) throw new Error(`가리키는 항목이 없다: ${it.id} -> ${it.file}`);
  return { index: d.index, groups: Array.isArray(d.groups) ? d.groups.filter((g) => g && typeof g.id === 'string' && typeof g.title === 'string') : [] };
}

export class ServerData {
  // fetchImpl과 timeoutMs는 시험에서 바꿔 끼운다.
  constructor(base, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 5000 } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.ok = false; // 목록을 한 번 받아 본 뒤에야 true. 실패하면 false로 돌아가 정적 파일을 쓴다
    this.meta = null;
    this.requests = 0;
  }

  async _get(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    this.requests++;
    try {
      const r = await this.fetch(`${this.base}${path}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 서버가 하는 일과 목록을 받는다. 성공하면 { meta, index, groups }, 실패하면 오류(ok는 false).
  async connect() {
    try {
      this.meta = await this._get('/api/meta');
      if (!this.meta?.library) throw new Error('서버에 미리 계산한 값이 없다');
      const lib = parseLibrary(await this._get('/api/library'));
      this.ok = true;
      return { meta: this.meta, ...lib };
    } catch (e) {
      this.ok = false;
      throw e;
    }
  }

  // 녹화 하나(파일 이름 = 목록의 id). 실패하면 오류를 던지고 ok를 false로 돌린다.
  async rec(id) {
    if (!ID_RE.test(id)) throw new Error(`올바르지 않은 id: ${id}`);
    try {
      return await this._get(`/api/library/${id}`);
    } catch (e) {
      this.ok = false;
      throw e;
    }
  }
}
