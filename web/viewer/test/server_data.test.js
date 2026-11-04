import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ServerData, apiBaseFromWs, parseLibrary } from '../src/server_data.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const index = read('../public/data/index.json');
const groups = read('../public/data/library.json').groups;

const fakeFetch = (routes, log = []) => async (url, opts) => {
  log.push(url);
  const path = new URL(url).pathname;
  const r = routes[path];
  if (r instanceof Error) throw r;
  if (r === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => r };
};

describe('apiBaseFromWs', () => {
  it('ws와 wss 주소를 http와 https 기본 주소로 바꾼다(경로는 버린다)', () => {
    expect(apiBaseFromWs('ws://127.0.0.1:8765/ws')).toBe('http://127.0.0.1:8765');
    expect(apiBaseFromWs('wss://sim.example.com/ws')).toBe('https://sim.example.com');
    expect(apiBaseFromWs('https://sim.example.com:8443/x')).toBe('https://sim.example.com:8443');
  });
  it('이상한 주소는 null', () => {
    for (const bad of ['', 'not a url', 'ftp://x/y', 'javascript:alert(1)', 'file:///etc/passwd']) expect(apiBaseFromWs(bad), bad).toBeNull();
  });
});

describe('parseLibrary', () => {
  it('저장소의 실제 목록을 통과시킨다', () => {
    const r = parseLibrary({ version: 1, groups, index });
    expect(r.index).toHaveLength(12);
    expect(r.groups.map((g) => g.id)).toEqual(['event', 'supply', 'load']);
  });
  it('틀린 항목, 가리키는 항목이 없는 alias, 이상한 id를 거절한다', () => {
    const ok = { id: 'a', title: 'A', n: 3 };
    expect(() => parseLibrary(null)).toThrow();
    expect(() => parseLibrary({ index: [] })).toThrow();
    expect(() => parseLibrary({ index: [{ ...ok, id: '../x' }] })).toThrow('올바르지 않다');
    expect(() => parseLibrary({ index: [{ ...ok, n: 0 }] })).toThrow();
    expect(() => parseLibrary({ index: [{ ...ok, file: 'zzz' }] })).toThrow('가리키는 항목이 없다');
    expect(() => parseLibrary({ index: [{ ...ok, file: '../etc' }] })).toThrow();
  });
  it('groups가 없거나 이상하면 빈 목록', () => {
    expect(parseLibrary({ index: [{ id: 'a', title: 'A', n: 1 }], groups: [{ id: 1 }] }).groups).toEqual([]);
  });
});

describe('ServerData', () => {
  it('meta와 목록을 받으면 ok가 되고 녹화를 id로 받는다', async () => {
    const log = [];
    const sd = new ServerData('http://h:1', { fetchImpl: fakeFetch({ '/api/meta': { library: true, solver: 'l0' }, '/api/library': { index, groups }, '/api/library/normal': { version: 1, n: 300 } }, log) });
    const r = await sd.connect();
    expect(sd.ok).toBe(true);
    expect(r.index).toHaveLength(12);
    expect((await sd.rec('normal')).n).toBe(300);
    expect(log).toEqual(['http://h:1/api/meta', 'http://h:1/api/library', 'http://h:1/api/library/normal']);
  });
  it('서버에 라이브러리가 없으면 연결을 쓰지 않는다', async () => {
    const sd = new ServerData('http://h:1', { fetchImpl: fakeFetch({ '/api/meta': { library: false } }) });
    await expect(sd.connect()).rejects.toThrow('미리 계산한 값이 없다');
    expect(sd.ok).toBe(false);
  });
  it('API가 없는 서버(404)나 네트워크 오류는 오류로 끝나고 ok는 false', async () => {
    const a = new ServerData('http://h:1', { fetchImpl: fakeFetch({}) });
    await expect(a.connect()).rejects.toThrow('404');
    const b = new ServerData('http://h:1', { fetchImpl: fakeFetch({ '/api/meta': new Error('연결 거부') }) });
    await expect(b.connect()).rejects.toThrow('연결 거부');
    expect(a.ok || b.ok).toBe(false);
  });
  it('녹화 받기가 실패하면 ok가 false로 돌아가 호출한 쪽이 정적 파일을 쓰게 된다', async () => {
    const sd = new ServerData('http://h:1', { fetchImpl: fakeFetch({ '/api/meta': { library: true }, '/api/library': { index, groups } }) });
    await sd.connect();
    await expect(sd.rec('normal')).rejects.toThrow('404');
    expect(sd.ok).toBe(false);
  });
  it('올바르지 않은 id는 요청을 보내지 않는다', async () => {
    const log = [];
    const sd = new ServerData('http://h:1', { fetchImpl: fakeFetch({}, log) });
    await expect(sd.rec('../../etc/passwd')).rejects.toThrow('올바르지 않은 id');
    expect(log).toEqual([]);
  });
  it('시간이 지나도 응답이 없으면 중단한다', async () => {
    const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('중단됨'))));
    const sd = new ServerData('http://h:1', { fetchImpl: hang, timeoutMs: 30 });
    await expect(sd.connect()).rejects.toThrow('중단됨');
  });
});
