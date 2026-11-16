import { describe, expect, it } from 'vitest';
import { buildingTap, cacNote } from '../src/hall_logic.js';

describe('buildingTap(외관 건물 누르기)', () => {
  it('마우스는 건물을 누르면 바로 들어가고 외곽선은 건드리지 않는다', () => {
    expect(buildingTap(false, true, 'mouse')).toEqual({ armed: false, hover: null, pinned: false, enter: true });
    expect(buildingTap(false, false, 'mouse').enter).toBe(false);
  });
  it('터치는 첫 탭에 정보, 두 번째 탭에 들어가고, 빈 곳을 누르면 풀린다', () => {
    const first = buildingTap(false, true, 'touch');
    expect(first).toEqual({ armed: true, hover: true, pinned: true, enter: false });
    expect(buildingTap(first.armed, true, 'touch')).toEqual({ armed: false, hover: false, pinned: false, enter: true });
    expect(buildingTap(true, false, 'touch')).toEqual({ armed: false, hover: false, pinned: false, enter: false });
  });
});

describe('cacNote(CAC 보기 안내)', () => {
  it('HAC 보기이고 값도 HAC면 숨긴다', () => {
    expect(cacNote({ viewCold: false, recCold: false, serverCold: false }).hidden).toBe(true);
  });
  it('CAC 보기에서 녹화가 CAC 계산이면 "값도 CAC 계산", 아니면 "값은 HAC 기준"', () => {
    expect(cacNote({ viewCold: true, recCold: true, serverCold: false })).toMatchObject({ hidden: false, text: '값도 CAC 계산' });
    expect(cacNote({ viewCold: true, recCold: false, serverCold: false })).toMatchObject({ hidden: false, text: '값은 HAC 기준' });
  });
  it('HAC 보기라도 서버 값이 CAC면 알린다', () => {
    const n = cacNote({ viewCold: false, recCold: false, serverCold: true });
    expect(n).toMatchObject({ hidden: false, text: '값은 CAC 계산(서버)' });
    expect(n.title).toContain('서버');
  });
});
