// 데이터 출처 전환(docs/30 M8, L4). main.js에서 떼어 내 가짜 출처로 경쟁 상황을 시험한다.
// 규칙
// - 지금 출처는 하나다. 다른 출처로 옮기면 옛 출처를 닫고 onLeave(옛 값 지우기 등)를 부른다.
// - 열기(open)는 느릴 수 있다. 그 사이에 다른 전환이 시작되면 늦게 끝난 쪽의 결과(성공이든 실패든)는 화면에 반영하지 않는다.
// - 열기에 실패하면 onFail을 부른다. 같은 출처 안에서 시나리오만 바꾸다 실패하면 true(출처는 그대로), 다른 출처로 옮기다 실패하면 false.
export class SourceManager {
  constructor({ onLeave = () => {}, onEnter = () => {}, onReady = () => {}, onFail = () => {} } = {}) {
    this.current = null;
    this.seq = 0;
    this.done = 0; // 마지막으로 끝난(반영 여부와 상관없이) 전환 순번
    this.hooks = { onLeave, onEnter, onReady, onFail };
  }

  /** 지금 출처의 종류(없으면 기본값 rec). */
  get kind() {
    return this.current?.kind ?? 'rec';
  }

  async use(next, args) {
    const mine = ++this.seq;
    const prev = this.current;
    if (prev && prev !== next) {
      prev.close();
      this.hooks.onLeave(prev, next);
    }
    this.current = next;
    this.hooks.onEnter(next); // 열기에 실패해도 어느 출처인지는 보인다
    let failure = null;
    try {
      await next.open(args);
    } catch (e) {
      failure = e;
    }
    if (mine !== this.seq) return false; // 그 사이에 다른 출처나 시나리오를 골랐다
    this.done = mine;
    if (failure) {
      this.hooks.onFail(failure, next);
      return prev === next;
    }
    this.hooks.onReady(next);
    return true;
  }

  /** 마지막 전환의 열기가 끝났는지(화면 시험이 고정 대기 대신 기다린다). */
  get settled() {
    return this.done === this.seq;
  }

  /** 이 출처가 아직 지금 출처인지(비동기 작업이 끝났을 때 확인용). */
  isCurrent(src) {
    return this.current === src;
  }
}
