import { describe, expect, it } from 'vitest';
import { SourceManager } from '../src/source_manager.js';

// 열기를 밖에서 끝낼 수 있는 가짜 출처
function fake(kind) {
  const s = { kind, closed: 0, pending: [] };
  s.open = () => new Promise((resolve, reject) => s.pending.push({ resolve, reject }));
  s.close = () => { s.closed += 1; };
  s.finish = (err) => { const p = s.pending.shift(); err ? p.reject(err) : p.resolve(); };
  return s;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function make() {
  const log = [];
  const m = new SourceManager({
    onLeave: (p, n) => log.push(`leave:${p.kind}->${n.kind}`),
    onEnter: (s) => log.push(`enter:${s.kind}`),
    onReady: (s) => log.push(`ready:${s.kind}`),
    onFail: (e, s) => log.push(`fail:${s.kind}:${e.message}`),
  });
  return { m, log };
}

describe('SourceManager', () => {
  it('처음 출처를 열면 화면에 반영한다', async () => {
    const { m, log } = make();
    const rec = fake('rec');
    const p = m.use(rec, { scenarioId: 'a' });
    rec.finish();
    expect(await p).toBe(true);
    expect(m.kind).toBe('rec');
    expect(log).toEqual(['enter:rec', 'ready:rec']);
  });

  it('느린 열기가 나중에 끝나도 마지막 전환만 반영한다(H6)', async () => {
    const { m, log } = make();
    const rec = fake('rec');
    const sim = fake('sim');
    const slow = m.use(rec, {});
    const fast = m.use(sim, {});
    sim.finish();
    expect(await fast).toBe(true);
    rec.finish(); // 늦게 끝난 녹화
    expect(await slow).toBe(false);
    expect(m.current).toBe(sim);
    expect(log.filter((x) => x.startsWith('ready'))).toEqual(['ready:sim']);
    expect(rec.closed).toBe(1);
  });

  it('늦게 온 실패도 버린다(지금 출처의 표시를 덮어쓰지 않는다)', async () => {
    const { m, log } = make();
    const rec = fake('rec');
    const lib = fake('lib');
    const a = m.use(rec, {});
    const b = m.use(lib, {});
    lib.finish();
    await b;
    rec.finish(new Error('늦은 실패'));
    expect(await a).toBe(false);
    expect(log.some((x) => x.startsWith('fail'))).toBe(false);
    expect(m.kind).toBe('lib');
  });

  it('같은 출처에서 시나리오를 연달아 바꾸면 닫지 않고 마지막 것만 반영한다', async () => {
    const { m, log } = make();
    const rec = fake('rec');
    const a = m.use(rec, { scenarioId: 'a' });
    const b = m.use(rec, { scenarioId: 'b' });
    rec.finish();
    rec.finish();
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(rec.closed).toBe(0);
    expect(log.filter((x) => x.startsWith('leave'))).toEqual([]);
    expect(log.filter((x) => x.startsWith('ready'))).toEqual(['ready:rec']);
  });

  it('열기 실패: 같은 출처면 true, 다른 출처로 옮기다 실패하면 false', async () => {
    const { m, log } = make();
    const rec = fake('rec');
    const sim = fake('sim');
    const p0 = m.use(rec, {});
    rec.finish();
    await p0;
    const p1 = m.use(rec, { scenarioId: 'x' });
    rec.finish(new Error('없음'));
    expect(await p1).toBe(true);
    const p2 = m.use(sim, {});
    sim.finish(new Error('끊김'));
    expect(await p2).toBe(false);
    expect(log).toContain('fail:rec:없음');
    expect(log).toContain('fail:sim:끊김');
    expect(m.current).toBe(sim); // 실패해도 어느 출처를 골랐는지는 남는다
  });

  it('세 번 연달아 바꾸면 중간 것들은 반영되지 않고 옛 출처는 한 번씩 닫힌다', async () => {
    const { m, log } = make();
    const [a, b, c] = [fake('rec'), fake('lib'), fake('live')];
    const pa = m.use(a, {});
    const pb = m.use(b, {});
    const pc = m.use(c, {});
    expect(m.settled).toBe(false);
    b.finish();
    c.finish();
    a.finish();
    await tick();
    expect(await Promise.all([pa, pb, pc])).toEqual([false, false, true]);
    expect([a.closed, b.closed, c.closed]).toEqual([1, 1, 0]);
    expect(log.filter((x) => x.startsWith('ready'))).toEqual(['ready:live']);
    expect(m.isCurrent(c)).toBe(true);
    expect(m.settled).toBe(true);
  });
});
