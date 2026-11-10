import { describe, expect, it } from 'vitest';
import { JobClient, conditionsFrom, formatEta, summarize } from '../src/sim/jobs.js';

const CRACS = ['crac_01', 'crac_02', 'crac_03'];
const ROWS = [1, 2];

describe('서버 작업 조건 만들기', () => {
  it('기본값은 빼서 같은 조건이면 같은 요청이 된다', () => {
    expect(conditionsFrom({}, CRACS, ROWS)).toEqual({ duration: 300, supply: 18, precise: true });
    expect(conditionsFrom({ fans: { crac_01: 1 }, rows: { 1: 1 } }, CRACS, ROWS)).toEqual({ duration: 300, supply: 18, precise: true });
  });
  it('범위를 넘는 값은 잘라 서버 범위 안으로', () => {
    const c = conditionsFrom({ duration: 5, supply: 40, fans: { crac_02: 1.7 }, rows: { 2: 9 } }, CRACS, ROWS);
    expect(c.duration).toBe(60);
    expect(c.supply).toBe(27);
    expect(c.fans).toBeUndefined(); // 1.7은 1로 잘려 기본값
    expect(c.power).toEqual({ 'row:02': 1.5 });
  });
  it('끈 CRAC은 팬 0, 고장은 길이 안의 시각으로, 이미 끈 CRAC의 고장은 넣지 않는다', () => {
    const c = conditionsFrom({ duration: 120, off: { crac_03: true }, fans: { crac_01: 0.4 }, failure: { crac: 'crac_02', t: 500 } }, CRACS, ROWS);
    expect(c.fans).toEqual({ crac_01: 0.4, crac_03: 0 });
    expect(c.failures).toEqual([{ crac: 'crac_02', t: 119 }]);
    expect(conditionsFrom({ off: { crac_02: true }, failure: { crac: 'crac_02', t: 10 } }, CRACS, ROWS).failures).toBeUndefined();
  });
  it('요약 문장', () => {
    const s = summarize({ duration: 300, supply: 18, precise: true, fans: { crac_03: 0 }, failures: [{ crac: 'crac_02', t: 60 }], power: { 'row:01': 1.2 } });
    expect(s).toContain('CRAC_03 꺼짐');
    expect(s).toContain('60초에 CRAC_02 고장');
    expect(s).toContain('1줄 120%');
    expect(s).toContain('정확(OpenFOAM 흐름)');
    // 서버가 돌려주는 정리된 조건(모든 공조기 1.0 포함)에서도 기본값은 나열하지 않는다
    expect(summarize({ duration: 60, supply: 18, precise: false, fans: { crac_01: 1, crac_02: 0.5 }, power: {} })).toBe('60초 · 급기 18°C · CRAC_02 50% · 빠름(보정 모델)');
  });
  it('남은 시간 문장', () => {
    expect(formatEta(null)).toBe('남은 시간 계산 중');
    expect(formatEta(42)).toBe('약 42초 남음');
    expect(formatEta(780)).toBe('약 13분 남음');
    expect(formatEta(7200)).toBe('약 2시간 0분 남음');
  });
});

class FakeWS {
  static last;
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
  }
  send(m) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.onclose?.();
  }
}

describe('작업 연결', () => {
  it('연결 전 요청은 모았다가 보내고, 토큰을 먼저 보낸다', () => {
    const c = new JobClient('ws://x', { token: 't'.repeat(20), WebSocketImpl: FakeWS });
    c.start();
    c.submit({ duration: 60 });
    FakeWS.last.onopen();
    expect(FakeWS.last.sent.map((m) => m.type)).toEqual(['auth', 'job']);
    expect(FakeWS.last.sent[1]).toEqual({ type: 'job', action: 'submit', conditions: { duration: 60 } });
  });
  it('작업 알림, 결과, 오류만 받고 실시간 값은 무시한다', () => {
    const got = { jobs: [], res: [], err: [] };
    const c = new JobClient('ws://x', { WebSocketImpl: FakeWS, onJob: (j) => got.jobs.push(j), onResult: (id, r) => got.res.push([id, r]), onError: (e) => got.err.push(e) });
    c.start();
    FakeWS.last.onopen();
    const msg = (o) => FakeWS.last.onmessage({ data: JSON.stringify(o) });
    msg({ type: 'sample', sensorId: 'X', value: 1 });
    msg({ type: 'job', job: { id: 'abc123', state: 'running', progress: 0.5 } });
    msg({ type: 'job_result', id: 'abc123', rec: { version: 1 } });
    msg({ type: 'error', message: '길이는 60~1800이어야 한다' });
    expect(got.jobs).toHaveLength(1);
    expect(c.jobs.get('abc123').progress).toBe(0.5);
    expect(got.res).toEqual([['abc123', { version: 1 }]]);
    expect(got.err).toEqual(['길이는 60~1800이어야 한다']);
  });
});
