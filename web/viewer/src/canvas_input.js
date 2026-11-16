// 캔버스 입력(누르기, 끌기, 말풍선, 화살표 키)을 화면 동작으로 잇는다(docs/30 L4, main.js에서 옮김).
// 판단 규칙은 src/hall_logic.js(buildingTap, canvasArrow, 단위 시험)에 있고, 여기는 DOM 이벤트와 실행만 한다.
import { buildingTap, canvasArrow, rackGrid } from './hall_logic.js';
import { VIEWS } from './views.js';
import { METRIC_LABEL, prettyName } from './ui.js';

/**
 * ctx: { canvas, scene, ui, store, flow, racks, getView(), getSelected(), select(eq, focus), enterHall(), glLost(엘리먼트) }
 * 돌려주는 값: { disarm() } — 화면 단계가 바뀌면 터치로 고른 건물 상태를 푼다.
 */
export function bindCanvasInput(ctx) {
  const { canvas, scene, ui, store, flow } = ctx;
  let armed = false; // 터치: 건물을 한 번 눌러 정보를 보여 준 상태
  // 모바일에서 탭 전환이나 그래픽 재설정으로 컨텍스트를 잃으면 검게 멈춘다. three.js가 복구를 시도하므로 우리는 안내만 한다.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    ctx.glLost.hidden = false;
  });
  canvas.addEventListener('webglcontextrestored', () => (ctx.glLost.hidden = true));
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, px: e.clientX - r.left, py: e.clientY - r.top };
  };
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // 끌기는 선택이 아니다
    const p = at(e);
    if (flow.stage === 'exterior') {
      const t = buildingTap(armed, scene.pickBuilding(p.x, p.y), e.pointerType);
      armed = t.armed;
      if (t.hover !== null) {
        scene.setBuildingHover(t.hover);
        ui.setBuildingState(t.pinned ? { pinned: true } : undefined);
      }
      if (t.enter) ctx.enterHall();
      return;
    }
    const eq = scene.pick(p.x, p.y);
    if (eq) ctx.select(eq);
    else if (ctx.getSelected()) ctx.select(ctx.getSelected()); // 빈 곳: 해제
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return ui.hideTooltip();
    const p = at(e);
    if (flow.stage === 'exterior') {
      if (e.pointerType !== 'mouse') return;
      const hit = scene.pickBuilding(p.x, p.y);
      canvas.classList.toggle('over-building', hit);
      scene.setBuildingHover(hit);
      ui.setBuildingState({ hot: hit });
      return;
    }
    const eq = scene.pick(p.x, p.y);
    scene.hover(eq);
    if (!eq) return ui.hideTooltip();
    const v = VIEWS[ctx.getView()];
    const rack = eq.startsWith('rack');
    const m = rack ? store.metric(eq, v.metric) : store.metric(eq, 'fan_speed');
    const unit = rack ? v.unit : '%';
    const label = rack ? v.label : METRIC_LABEL.fan_speed;
    ui.showTooltip(`${prettyName(eq)}  ${label} ${m && Number.isFinite(m.value) ? m.value.toFixed(1) : '–'} ${unit}`, p.px, p.py);
  });
  canvas.addEventListener('pointerleave', (e) => {
    scene.hover(null);
    ui.hideTooltip();
    if (e.pointerType === 'mouse') (scene.setBuildingHover(false), ui.setBuildingState());
  });

  // 방향키로 랙 이동(FR-34): 줄은 위아래, 같은 줄은 좌우
  const nextRack = rackGrid(ctx.racks);
  canvas.addEventListener('keydown', (e) => {
    const d = canvasArrow(e.key, flow.stage);
    if (!d) return;
    e.preventDefault();
    ctx.select(nextRack(ctx.getSelected(), d[0], d[1]), true);
  });
  return { disarm: () => (armed = false) };
}
