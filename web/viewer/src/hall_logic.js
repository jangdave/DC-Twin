// main.js에서 떼어 낸 화면과 무관한 계산(docs/30 L4). 저장소(store)와 배치(layout)만 받고 DOM은 만지지 않는다.

/** 서버가 알려 준 조작 상태(snapshot의 controls와 그 뒤의 이벤트)를 접어 슬라이더 값으로 만든다. 서버가 기준이다. */
export class ServerModel {
  constructor(layout) {
    this.layout = layout; // { cracs: [...], racks: [{ name, row }] }
    this.fan = {};
    this.powerScale = {};
    this.racks = layout.racks;
    this.supply = null;
    this._ctl = undefined;
    this._ev = 0;
  }

  /** controls(snapshot)로 처음부터 다시 맞춘다. */
  reset(controls) {
    const { cracs, racks } = this.layout;
    this.fan = Object.fromEntries(cracs.map((x) => [x, controls?.fan?.[x] ?? 1]));
    this.powerScale = Object.fromEntries(racks.map((r) => [r.name, controls?.powerScale?.[r.name] ?? 1]));
    this.supply = Number.isFinite(controls?.supply) ? controls.supply : null;
    this._ev = 0;
    return this;
  }

  /** 저장소의 controls와 이벤트를 반영한다. snapshot이 바뀌었거나 이벤트가 줄었으면(새 시작) 처음부터 다시 접는다. */
  sync(store) {
    if (store.controls !== this._ctl || store.events.length < this._ev) {
      this._ctl = store.controls;
      this.reset(store.controls);
    }
    for (; this._ev < store.events.length; this._ev++) {
      const e = store.events[this._ev];
      if (e.kind === 'supply_temp') this.supply = e.value;
      else if (e.kind === 'crac_fan' && e.target in this.fan) this.fan[e.target] = e.value;
      else if (e.kind === 'rack_power_scale') {
        const names = e.target.startsWith('row:') ? this.layout.racks.filter((r) => r.row === Number(e.target.slice(4))).map((r) => r.name) : [e.target];
        for (const n of names) if (n in this.powerScale) this.powerScale[n] = e.value;
      }
    }
    return this;
  }
}

/**
 * 모니터링에 보이는 지금 값(랙 입구·출구 온도, 공조기 팬, 급기 온도). 간이 계산의 시작값이 된다.
 * 급기 온도: serverSupply(서버가 알려 준 설정값)가 있으면 그것, 없으면 팬이 정상인 공조기의 공급 온도 가운데 가장 낮은 값
 * (공급 온도 = 급기 + 팬이 줄면 오르는 몫).
 */
export function monitorSeed(store, rackKeys, cracs, serverSupply = null) {
  const num = (e) => (e && Number.isFinite(e.value) ? e.value : undefined);
  const inlet = {};
  const outlet = {};
  for (const k of rackKeys) {
    inlet[k] = num(store.metric(k, 'temp_in'));
    outlet[k] = num(store.metric(k, 'temp_out'));
  }
  const fan = {};
  for (const c of cracs) {
    const f = num(store.metric(c, 'fan_speed'));
    if (f !== undefined) fan[c] = Math.min(Math.max(f / 100, 0), 1);
  }
  let supply = serverSupply;
  if (!Number.isFinite(supply)) {
    const vals = cracs.filter((c) => (fan[c] ?? 1) > 0.99).map((c) => num(store.metric(c, 'supply_temp'))).filter((v) => v !== undefined);
    supply = vals.length ? Math.min(...vals) : null;
  }
  return { inlet, outlet, fan, supply };
}

/** 방향키로 랙 이동(FR-34): 줄은 위아래, 같은 줄은 좌우(x 순서). 끝에서는 멈춘다. 돌려주는 값은 랙 키(소문자). */
export function rackGrid(racks) {
  const byRow = new Map();
  for (const r of racks) {
    if (!byRow.has(r.row)) byRow.set(r.row, []);
    byRow.get(r.row).push(r);
  }
  for (const list of byRow.values()) list.sort((a, b) => a.min[0] - b.min[0]);
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  return (selected, dRow, dCol) => {
    const cur = selected && racks.find((r) => r.name.toLowerCase() === selected);
    if (!cur) return racks[0].name.toLowerCase();
    const ri = Math.min(Math.max(rows.indexOf(cur.row) + dRow, 0), rows.length - 1);
    const list = byRow.get(rows[ri]);
    const ci = Math.min(Math.max(byRow.get(cur.row).indexOf(cur) + dCol, 0), list.length - 1);
    return list[ci].name.toLowerCase();
  };
}

/**
 * 키보드 입력을 화면 동작으로 바꾼다(FR-34, FR-83). DOM은 보지 않고 필요한 사실만 받는다.
 *   key: { key, shiftKey, inDialog, inField(입력칸·단추·대화상자 안), onCanvas }
 *   ctx: { stage: 'exterior'|'hall', overlay, hasPlayer }
 * 돌려주는 값: { type: 'closeOverlay' | 'back' | 'enterHall' | 'togglePlay' | 'seekBy', by? } 또는 null(처리 안 함).
 * 캔버스의 화살표(랙 이동)는 canvasArrow가 따로 처리한다.
 */
export function keyAction(key, ctx) {
  if (key.key === 'Escape' && !key.inDialog) return ctx.overlay ? { type: 'closeOverlay' } : { type: 'back' };
  if (key.inField) return null;
  if (key.key === 'Enter' && ctx.stage === 'exterior') return { type: 'enterHall' };
  if (!ctx.hasPlayer) return null;
  if (key.key === ' ') return { type: 'togglePlay' };
  if ((key.key === 'ArrowLeft' || key.key === 'ArrowRight') && !key.onCanvas) return { type: 'seekBy', by: (key.shiftKey ? 30 : 5) * (key.key === 'ArrowLeft' ? -1 : 1) };
  return null;
}

/** 서버실에서 캔버스에 초점이 있을 때 화살표: 랙 이동 [줄, 칸] 또는 null. */
export function canvasArrow(key, stage) {
  if (stage !== 'hall') return null;
  return { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[key] ?? null;
}
