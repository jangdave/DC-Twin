// 게이트웨이 WebSocket 라이브 연결 (docs/18 4.4, 5.7장).
import { applyMessage } from './apply.js';
import { parseMessage } from './messages.js';

// 재접속 간격(ms): 2초부터 늘려 가며 최대 10초
export function reconnectDelay(attempt) {
  return Math.min(10000, Math.round(2000 * 1.5 ** attempt));
}

export class LiveClient {
  // WebSocketImpl과 타이머 함수는 시험에서 바꿔 끼운다.
  // token: 서버가 접근 토큰을 요구할 때. 연결하자마자 첫 메시지로 보낸다(주소에 넣지 않으므로 서버 로그나 기록에 남지 않는다).
  constructor(url, store, { WebSocketImpl = globalThis.WebSocket, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onState = () => {}, token = null } = {}) {
    this.url = url;
    this.token = token;
    this.denied = null; // 서버가 인증을 거절하면 'missing'(토큰을 안 보냄) 또는 'wrong'(토큰이 틀림). 이때는 다시 시도하지 않는다
    this.store = store;
    this.WS = WebSocketImpl;
    // 브라우저의 setTimeout은 다른 객체의 메서드로 부르면 "Illegal invocation"이 나므로 함수로 감싼다
    this.setT = (fn, ms) => setTimeoutImpl(fn, ms);
    this.clearT = (id) => clearTimeoutImpl(id);
    this.onState = onState;
    this.state = 'idle'; // idle | connecting | open | closed
    this.attempt = 0;
    this.queue = [];
    this.dropped = 0; // 형식이 틀려 버린 메시지 수
    this.lastMessageAt = null;
    this.retryInMs = 0;
    this._stopped = false;
    this.lastError = null; // 서버가 거절한 조작의 이유
  }

  // 서버에 조작을 보낸다. 연결되어 있을 때만 보내고, 보냈는지 돌려준다.
  send(obj) {
    if (this.state !== 'open' || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  _set(state) {
    this.state = state;
    this.onState(state, this);
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._timer) this.clearT(this._timer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 이미 닫힘 */
      }
    }
    this._set('idle');
  }

  _connect() {
    this._set('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return; // stop() 뒤 start()로 새 연결을 만들었다면 옛 연결의 늦은 알림은 버린다
      if (this.token) {
        try {
          ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        } catch {
          /* 보내지 못하면 서버가 시간 초과로 닫는다 */
        }
      }
      this.attempt = 0;
      this._set('open');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const m = parseMessage(ev.data);
      if (!m) {
        this.dropped++;
        return;
      }
      this.queue.push(m);
      this.lastMessageAt = Date.now();
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this._stopped || this.ws !== ws) return;
      this.flush(); // 끊기기 전에 받아 둔 메시지를 먼저 반영해야 그 뒤의 '오래된 값' 표시가 덮어써지지 않는다
      this._markStale();
      if (ev?.code === 1008) {
        // 서버가 인증을 거절했다(토큰이 없거나 틀림). 같은 토큰으로 다시 시도해도 소용없으니 멈춘다(서버의 잠금을 부르지 않게)
        this.denied = this.token ? 'wrong' : 'missing';
        this.lastError = { message: this.denied === 'wrong' ? '접근 토큰이 맞지 않다' : '서버가 접근 토큰을 요구한다', at: Date.now() };
        this._set('denied');
        return;
      }
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    this.retryInMs = reconnectDelay(this.attempt++); // 상태 알림보다 먼저 정해서 화면이 정확한 간격을 보이게 한다
    this._set('closed');
    this._timer = this.setT(() => this._connect(), this.retryInMs);
  }

  // 끊긴 동안은 마지막 값을 오래된 값으로 표시한다
  _markStale() {
    for (const e of this.store.latest.values()) e.quality = 'stale';
    this.store.version++;
  }

  // 한 프레임에 한 번 쌓인 메시지를 저장소에 반영한다(초당 수백 건이 와도 화면이 밀리지 않게)
  flush() {
    const q = this.queue;
    if (!q.length) return 0;
    this.queue = [];
    for (const m of q) {
      if (m.kind === 'auth') continue; // 인증 확인은 화면에 반영할 값이 아니다
      if (m.kind === 'error') {
        this.lastError = { message: m.message, at: Date.now() };
        continue;
      }
      applyMessage(this.store, m);
    }
    return q.length;
  }
}
