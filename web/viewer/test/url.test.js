import { describe, expect, it } from 'vitest';
import { checkLiveUrl, isLocalUrl, parseParams } from '../src/url.js';

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
  it('debug=1일 때만 점검 훅을 연다(docs/30 L3)', () => {
    expect(parseParams('', ids).debug).toBe(false);
    expect(parseParams('?debug=1', ids).debug).toBe(true);
    expect(parseParams('?debug=true', ids).debug).toBe(false);
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
    expect(parseParams('', ids)).toEqual({ scenario: null, t: 0, live: null, liveError: null, view: null, stage: null, mode: null, models: true, server: null, sky: 'day', q: null, panel: 'default', fx: null, debug: false });
  });
  it('panel=open만 패널을 처음부터 펼친다', () => {
    expect(parseParams('?panel=open', ids).panel).toBe('open');
    expect(parseParams('?panel=x', ids).panel).toBe('default');
  });
  it('stage는 exterior와 hall만 받는다', () => {
    expect(parseParams('?stage=hall', ids).stage).toBe('hall');
    expect(parseParams('?stage=exterior', ids).stage).toBe('exterior');
    expect(parseParams('?stage=walk', ids).stage).toBeNull();
  });
  it('mode는 rec와 sim만 받는다', () => {
    expect(parseParams('?mode=sim', ids).mode).toBe('sim');
    expect(parseParams('?mode=rec', ids).mode).toBe('rec');
    expect(parseParams('?mode=x', ids).mode).toBeNull();
  });
  it('q=low|mid|high만 받는다', () => {
    expect(parseParams('?q=low', ids).q).toBe('low');
    expect(parseParams('?q=ultra', ids).q).toBeNull();
  });

  it('sky=dusk이면 저녁 하늘', () => {
    expect(parseParams('?sky=dusk', ids).sky).toBe('dusk');
    expect(parseParams('?sky=x', ids).sky).toBe('day');
  });

  it('models=0이면 장비 모양을 끈다', () => {
    expect(parseParams('?models=0', ids).models).toBe(false);
    expect(parseParams('?models=1', ids).models).toBe(true);
  });
  it('server는 이 컴퓨터의 ws://와 wss://만 받는다', () => {
    expect(parseParams('?server=ws://127.0.0.1:8765/ws', ids).server).toBe('ws://127.0.0.1:8765/ws');
    const bad = parseParams('?server=ws://example.com/ws', ids);
    expect(bad.server).toBeNull();
    expect(bad.liveError).toContain('127.0.0.1');
  });
});

describe('이 컴퓨터 주소 판정 (docs/30 M6)', () => {
  it('127.0.0.1, localhost, ::1만 이 컴퓨터로 본다', () => {
    expect(isLocalUrl('ws://127.0.0.1:8765/ws')).toBe(true);
    expect(isLocalUrl('wss://localhost/ws')).toBe(true);
    expect(isLocalUrl('ws://[::1]:8765/ws')).toBe(true);
    expect(isLocalUrl('wss://127.0.0.1.example.com/ws')).toBe(false);
    expect(isLocalUrl('wss://example.com/ws')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});
