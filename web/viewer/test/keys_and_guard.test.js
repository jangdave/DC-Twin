import { describe, expect, it } from 'vitest';
import { canvasArrow, keyAction } from '../src/hall_logic.js';
import { FrameGuard } from '../src/quality.js';

describe('FrameGuard(프레임 감시)', () => {
  const run = (g, fps, from, ms) => {
    let r = null;
    for (let t = from; t <= from + ms; t += 1000 / fps) r = g.tick(t) ?? r;
    return r;
  };
  it('처음 2.5초는 건너뛰고, 느리면 한 단계씩 낮추며, 충분하면 끝낸다', () => {
    const g = new FrameGuard('high');
    expect(g.tick(1)).toBeNull();
    const r1 = run(g, 15, 1, 6000);
    expect(r1).toMatchObject({ tier: 'mid' });
    expect(r1.fps).toBeLessThan(22);
    const r2 = run(g, 15, 7000, 5000);
    expect(r2?.tier).toBe('low');
    expect(run(g, 15, 13000, 6000)).toBeNull(); // 더 낮출 단계가 없으면 끝
    expect(g.on).toBe(false);
  });
  it('충분히 빠르면 낮추지 않고 끝, 꺼 두면 아무것도 하지 않는다', () => {
    const g = new FrameGuard('high');
    expect(run(g, 60, 1, 7000)).toBeNull();
    expect(g.on).toBe(false);
    expect(g.tier).toBe('high');
    const off = new FrameGuard('high', { on: false });
    expect(run(off, 5, 1, 7000)).toBeNull();
  });
});

describe('keyAction(키보드 규칙)', () => {
  const k = (key, o = {}) => ({ key, shiftKey: false, inDialog: false, inField: false, onCanvas: false, ...o });
  const hall = { stage: 'hall', overlay: null, hasPlayer: true };
  it('Esc: 겹친 창이 있으면 닫고, 없으면 뒤로. 대화상자 안에서는 무시', () => {
    expect(keyAction(k('Escape'), { ...hall, overlay: 'cctv' })).toEqual({ type: 'closeOverlay' });
    expect(keyAction(k('Escape'), hall)).toEqual({ type: 'back' });
    expect(keyAction(k('Escape', { inField: true }), hall)).toEqual({ type: 'back' }); // 입력칸에서도 Esc는 동작
    expect(keyAction(k('Escape', { inDialog: true, inField: true }), hall)).toBeNull();
  });
  it('Enter는 외관에서만 홀로, 입력칸에서는 아무것도 안 함', () => {
    expect(keyAction(k('Enter'), { ...hall, stage: 'exterior' })).toEqual({ type: 'enterHall' });
    expect(keyAction(k('Enter'), hall)).toBeNull();
    expect(keyAction(k('Enter', { inField: true }), { ...hall, stage: 'exterior' })).toBeNull();
  });
  it('재생: 공백은 재생/멈춤, 좌우는 5초(Shift 30초), 캔버스 위 좌우는 랙 이동이라 제외, 녹화가 없으면 무시', () => {
    expect(keyAction(k(' '), hall)).toEqual({ type: 'togglePlay' });
    expect(keyAction(k('ArrowRight'), hall)).toEqual({ type: 'seekBy', by: 5 });
    expect(keyAction(k('ArrowLeft', { shiftKey: true }), hall)).toEqual({ type: 'seekBy', by: -30 });
    expect(keyAction(k('ArrowLeft', { onCanvas: true }), hall)).toBeNull();
    expect(keyAction(k(' '), { ...hall, hasPlayer: false })).toBeNull();
  });
  it('캔버스 화살표는 서버실에서만 랙 이동', () => {
    expect(canvasArrow('ArrowUp', 'hall')).toEqual([-1, 0]);
    expect(canvasArrow('ArrowUp', 'exterior')).toBeNull();
    expect(canvasArrow('a', 'hall')).toBeNull();
  });
});
