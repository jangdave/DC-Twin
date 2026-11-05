// 작업 공간 상태 (화면 구조의 가운데 계층). DOM과 3D를 모르는 순수 함수만 둔다.
//
// 계층(위가 아래를 부른다. 아래는 위를 모른다):
//   1. 화면 조각 (index.html, style.css)  : 상태를 읽어 그리기만 한다. 스스로 켜고 끄지 않는다.
//   2. 화면 반영 (ui.js apply)            : derive()가 돌려준 값을 DOM에 한 번에 적용한다.
//   3. 작업 공간 상태 (이 파일)           : reduce()가 규칙을 지키며 다음 상태를 만들고, derive()가 화면 값을 계산한다.
//   4. 동작 연결 (main.js dispatch)       : 상태가 바뀐 결과로 3D, CCTV, 데이터 출처를 맞춘다.
//   5. 데이터 출처 (store, 녹화, 시뮬레이션, 서버): 값을 만든다. 화면 상태를 모른다.
//
// 규칙(불변식)은 reduce 한곳에만 있다.
//   - 왼쪽 메뉴에서 눌린 단추는 하나뿐이다(모니터링 | 시뮬레이션 | 간이 계산 | CCTV).
//   - CCTV는 서버실 안에서만 열린다. 외관으로 나가면 닫힌다.
//   - 시뮬레이션과 간이 계산에 들어가면 온도 색칠이 켜진다(값 색이 있어야 읽힌다).
//   - CCTV가 열려 있는 동안 3D 위 도구(보기 값, 범례, 모드 표시)는 숨는다.

export const MODES = ['rec', 'lib', 'sim', 'connecting', 'open', 'closed']; // 데이터 출처의 상태. rec 모니터링 기록, lib 미리 계산한 값, sim 브라우저 간이 계산

export const initial = Object.freeze({
  stage: 'exterior', // exterior | hall
  mode: 'rec', // 데이터 출처: rec(모니터링 기록) | lib(미리 계산한 값) | sim(브라우저 간이 계산) | connecting/open/closed(서버나 라이브)
  control: false, // 서버에 조작을 보내는 중인가(로컬 서버)
  overlay: null, // null | 'cctv' : 3D 대신 화면을 채우는 보기
  heat: false, // 온도 색칠
  timeline: false, // 기록 재생 막대를 보일지(녹화일 때만 의미가 있음)
});

export function reduce(ws, a) {
  switch (a.type) {
    case 'stage': {
      const s = { ...ws, stage: a.stage };
      if (a.stage !== 'hall') s.overlay = null;
      return s;
    }
    case 'mode': {
      const s = { ...ws, mode: a.mode, control: a.control ?? false };
      if (a.mode === 'sim' || a.mode === 'lib') s.heat = true;
      return s;
    }
    case 'overlay': {
      if (a.value === null) return ws.overlay === null ? ws : { ...ws, overlay: null };
      if (ws.stage !== 'hall') return ws;
      return ws.overlay === a.value ? ws : { ...ws, overlay: a.value };
    }
    case 'overlay-toggle': {
      if (ws.overlay === a.value) return { ...ws, overlay: null };
      return reduce(ws, { type: 'overlay', value: a.value });
    }
    case 'heat':
      return ws.heat === a.on ? ws : { ...ws, heat: a.on };
    case 'timeline':
      return ws.timeline === a.on ? ws : { ...ws, timeline: a.on };
    default:
      return ws;
  }
}

// 화면에 보일 값. 같은 상태는 항상 같은 값을 낸다.
export function derive(ws) {
  const ext = ws.stage === 'exterior';
  const cctv = ws.overlay === 'cctv' && !ext;
  const own = ws.mode === 'rec' || ws.mode === 'lib' || ws.mode === 'sim'; // 이 화면이 재생이나 계산을 직접 한다
  const calc = ws.mode === 'sim' || ws.control; // 슬라이더로 조작하는 출처(브라우저 간이 계산, 로컬 서버)
  const sim = calc || ws.mode === 'lib'; // 에너지·용량, 이상 대비 탭을 쓰는 출처
  const tools = !ext && !cctv; // 3D 위 도구를 보일 수 있는가
  return {
    rail: {
      hidden: ext,
      // 눌린 단추는 하나. CCTV가 열려 있으면 CCTV, 아니면 데이터 출처(서버 조작 중이면 위쪽 "로컬 서버"가 눌리므로 없음)
      active: ext ? null : cctv ? 'cctv' : ws.control ? null : ws.mode === 'rec' || ws.mode === 'lib' || ws.mode === 'sim' ? ws.mode : null,
    },
    serverOn: ws.control,
    cctvOpen: cctv,
    exteriorCard: ext,
    stageToolsHidden: !tools,
    modeBadgeHidden: cctv,
    backHidden: ext,
    legendHidden: !(ws.heat && tools),
    viewGroupHidden: !ws.heat,
    heat: ws.heat,
    timelineBtnHidden: ws.mode !== 'rec',
    transportHidden: !own || (ws.mode === 'rec' && !ws.timeline),
    timebarHidden: ws.mode === 'sim',
    liveInfoHidden: own,
    scenarioDisabled: !(own || ws.control),
    // 조작 탭은 슬라이더가 있을 때만, 에너지·용량과 이상 대비 탭은 미리 계산한 값에도 있다
    // CCTV 중에는 시뮬레이션 탭을 감춘다(CCTV는 현장 화면이라 계산 결과를 보이지 않는다)
    tabs: { control: calc && !cctv, energy: sim && !cctv, prep: sim && !cctv },
    homeTab: calc ? 'control' : ws.mode === 'lib' ? 'energy' : 'summary',
    // 상세 시뮬레이션은 서버에 연결해서 한다는 안내(서버에 연결 중이면 숨김)
    serverCta: !cctv && !ws.control && (ws.mode === 'rec' || ws.mode === 'lib' || ws.mode === 'sim'),
  };
}
