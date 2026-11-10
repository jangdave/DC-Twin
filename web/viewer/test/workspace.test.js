import { describe, expect, it } from 'vitest';
import { derive, initial, reduce } from '../src/workspace.js';

const run = (...actions) => actions.reduce((s, a) => reduce(s, a), initial);
const hall = { type: 'stage', stage: 'hall' };

describe('왼쪽 메뉴는 눌린 단추가 하나뿐이다', () => {
  it('시뮬레이션 중 CCTV를 열면 CCTV만 눌린다', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'sim' }, { type: 'overlay-toggle', value: 'cctv' }));
    expect(d.rail.active).toBe('cctv');
    expect(d.cctvOpen).toBe(true);
  });
  it('CCTV를 닫으면 데이터 출처 단추로 돌아간다', () => {
    const s = run(hall, { type: 'mode', mode: 'sim' }, { type: 'overlay-toggle', value: 'cctv' }, { type: 'overlay-toggle', value: 'cctv' });
    expect(derive(s).rail.active).toBe('sim');
  });
  it('모든 상태 조합에서 눌린 단추는 많아야 하나', () => {
    for (const stage of ['exterior', 'hall'])
      for (const mode of ['rec', 'lib', 'sim', 'connecting', 'open', 'closed'])
        for (const control of [false, true])
          for (const overlay of [null, 'cctv']) {
            const d = derive({ ...initial, stage, mode, control, overlay });
            expect([null, 'rec', 'lib', 'sim', 'cctv']).toContain(d.rail.active);
            if (d.cctvOpen) expect(d.rail.active).toBe('cctv');
          }
  });
  it('서버 실시간 값을 볼 때는 왼쪽 메뉴의 "모니터링"이 눌리고 위쪽 "로컬 서버"도 켜짐으로 보인다(docs/31)', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'open', control: true }));
    expect(d.rail.active).toBe('rec');
    expect(d.serverOn).toBe(true);
  });
});

describe('CCTV 규칙', () => {
  it('외관에서는 열리지 않는다', () => {
    expect(run({ type: 'overlay', value: 'cctv' }).overlay).toBeNull();
  });
  it('외관으로 나가면 닫힌다', () => {
    const s = run(hall, { type: 'overlay', value: 'cctv' }, { type: 'stage', stage: 'exterior' });
    expect(s.overlay).toBeNull();
    expect(derive(s).cctvOpen).toBe(false);
  });
  it('열려 있는 동안 3D 위 도구와 범례, 모드 표시가 숨는다', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'sim' }, { type: 'overlay', value: 'cctv' }));
    expect(d.stageToolsHidden).toBe(true);
    expect(d.legendHidden).toBe(true);
    expect(d.modeBadgeHidden).toBe(true);
  });
});

describe('시뮬레이션과 보기 값', () => {
  it('시뮬레이션에 들어가면 온도 색칠이 켜지고 범례가 보인다', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'sim' }));
    expect(d.heat).toBe(true);
    expect(d.legendHidden).toBe(false);
    expect(d.tabs).toEqual({ control: true, energy: true, prep: true });
    expect(d.homeTab).toBe('control');
  });
  it('녹화에서는 기본으로 색칠 없음, 기록 재생 막대는 켰을 때만 보인다', () => {
    let d = derive(run(hall, { type: 'mode', mode: 'rec' }));
    expect(d.heat).toBe(false);
    expect(d.viewGroupHidden).toBe(true);
    expect(d.transportHidden).toBe(true);
    expect(d.tabs).toEqual({ control: false, energy: false, prep: false });
    d = derive(run(hall, { type: 'mode', mode: 'rec' }, { type: 'timeline', on: true }));
    expect(d.transportHidden).toBe(false);
  });
  it('시뮬레이션에서는 재생 막대가 항상 보이고 시간 막대는 숨는다', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'sim' }));
    expect(d.transportHidden).toBe(false);
    expect(d.timebarHidden).toBe(true);
  });
  it('외관에서는 왼쪽 메뉴와 도구가 숨고 요약 카드가 보인다', () => {
    const d = derive(initial);
    expect(d.rail.hidden).toBe(true);
    expect(d.stageToolsHidden).toBe(true);
    expect(d.exteriorCard).toBe(true);
  });
});

describe('미리 계산한 값(lib)', () => {
  it('들어가면 색칠이 켜지고, 재생 막대와 시간 막대가 보이며, 에너지와 이상 대비 탭만 나온다(슬라이더 조작 탭은 없음)', () => {
    const d = derive(run(hall, { type: 'mode', mode: 'lib' }));
    expect(d.rail.active).toBe('lib');
    expect(d.heat).toBe(true);
    expect(d.transportHidden).toBe(false);
    expect(d.timebarHidden).toBe(false); // 기록이라 시간 이동이 된다
    expect(d.tabs).toEqual({ control: false, energy: true, prep: true });
    expect(d.homeTab).toBe('energy');
    expect(d.scenarioDisabled).toBe(false);
  });
  it('서버 연결 안내는 서버에 연결하지 않았을 때만 보인다', () => {
    for (const mode of ['rec', 'lib', 'sim']) expect(derive(run(hall, { type: 'mode', mode })).serverCta).toBe(true);
    expect(derive(run(hall, { type: 'mode', mode: 'open', control: true })).serverCta).toBe(false);
  });
  it('간이 계산(sim)과 미리 계산한 값(lib)은 서로 다른 메뉴 단추다', () => {
    expect(derive(run(hall, { type: 'mode', mode: 'sim' })).rail.active).toBe('sim');
    expect(derive(run(hall, { type: 'mode', mode: 'lib' })).rail.active).toBe('lib');
  });

  it('CCTV가 열려 있으면 시뮬레이션 탭과 서버 안내를 감춘다', () => {
    for (const mode of ['rec', 'lib', 'sim']) {
      const d = derive(run(hall, { type: 'mode', mode }, { type: 'overlay-toggle', value: 'cctv' }));
      expect(d.cctvOpen).toBe(true);
      expect(d.tabs).toEqual({ control: false, energy: false, prep: false });
      expect(d.serverCta).toBe(false);
      expect(d.transportHidden).toBe(true); // 재생 막대도 숨김
    }
    const lib = derive(run(hall, { type: 'mode', mode: 'lib' }));
    expect(lib.tabs.energy).toBe(true); // CCTV가 아니면 그대로
  });
});
