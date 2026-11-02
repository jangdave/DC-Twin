// 게이트웨이 WebSocket 라이브 연결 (docs/18 4.4, 5.7장).
import { applyMessage } from './apply.js';
import { parseMessage } from './messages.js';

// 재접속 간격(ms): 2초부터 늘려 가며 최대 10초
export function reconnectDelay(attempt) {
  return Math.min(10000, Math.round(2000 * 1.5 ** attempt));
}

export class LiveClient {
  // WebSocketImpl과 타이머 함수는 시험에서 바꿔 끼운다.
  constructor(url, store, { WebSocketImpl = globalThis.WebSocket, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onState = () => {} } = {}) {
    this.url = url;
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
    ws.onclose = () => {
      if (this._stopped || this.ws !== ws) return;
      this._markStale();
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
    for (const m of q) applyMessage(this.store, m);
    return q.length;
  }
}
