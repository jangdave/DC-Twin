import { describe, expect, it } from 'vitest';
import { checkLiveUrl, parseParams } from '../src/url.js';

describe('라이브 주소 규칙 (FR-63)', () => {
  it('로컬 ws와 모든 wss는 허용', () => {
    expect(checkLiveUrl('ws://127.0.0.1:8080/ws').ok).toBe(true);
    expect(checkLiveUrl('ws://localhost:8080/ws').ok).toBe(true);
    expect(checkLiveUrl('wss://example.com/ws').ok).toBe(true);
  });
  it('원격 ws와 다른 프로토콜은 거부', () => {
    expect(checkLiveUrl('ws://example.com/ws').ok).toBe(false);
    expect(checkLiveUrl('ws://127.0.0.1.evil.com/ws').ok).toBe(false);
    expect(checkLiveUrl('http://127.0.0.1/ws').ok).toBe(false);
    expect(checkLiveUrl('javascript:alert(1)').ok).toBe(false);
    expect(checkLiveUrl('not a url').ok).toBe(false);
  });
  it('거부 이유가 있다', () => {
    expect(checkLiveUrl('ws://example.com/ws').reason).toMatch(/127\.0\.0\.1/);
  });
});

describe('주소 매개변수', () => {
  const ids = ['normal', 'fan_fault'];
  it('시나리오, 시작 시각, 라이브, 보는 값', () => {
    const p = parseParams('?scenario=fan_fault&t=60&view=power&live=ws://127.0.0.1:8080/ws', ids);
    expect(p).toMatchObject({ scenario: 'fan_fault', t: 60, view: 'power', live: 'ws://127.0.0.1:8080/ws' });
  });
  it('모르는 시나리오와 이상한 시각, 나쁜 라이브 주소는 무시', () => {
    const p = parseParams('?scenario=zzz&t=-5&view=x&live=ws://example.com/ws', ids);
    expect(p.scenario).toBeNull();
    expect(p.t).toBe(0);
    expect(p.view).toBeNull();
    expect(p.live).toBeNull();
    expect(p.liveError).toBeTruthy();
  });
  it('아무것도 없으면 기본값', () => {
    expect(parseParams('', ids)).toEqual({ scenario: null, t: 0, live: null, liveError: null, view: null });
  });
});
