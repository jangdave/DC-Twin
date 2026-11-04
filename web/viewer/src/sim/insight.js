// 에너지, 용량, 이상 대비 화면의 계산(DOM과 무관한 순수 함수). docs/27 14장.
// 값은 간이 모델의 시각화 목적이다. 줄어드는 방향을 보여 줄 뿐 실제 절감량을 말하지 않는다.

export const RATED_KW = 10; // 랙 한 기의 정격 전력(가정: 엔진의 power_ref와 같은 값)
export const WARN_IN_DEFAULT = 27; // 입구 온도 주의 기준(센서 목록 값이 있으면 그 값을 쓴다)
export const OVERCOOL_MARGIN = 6; // 주의 기준까지 이만큼(도) 이상 남으면 "과냉각 의심(간이)"

const num = (v) => (Number.isFinite(v) ? v : null);

// 지금 값 한 장. store는 SensorStore(aggregates, metric, latest)
export function snapshot(store, rackKeys, warnIn = WARN_IN_DEFAULT) {
  const a = store.aggregates ?? {};
  let maxIn = null;
  let maxRack = null;
  for (const k of rackKeys) {
    const m = store.metric(k, 'temp_in');
    if (m && Number.isFinite(m.value) && (maxIn === null || m.value > maxIn)) {
      maxIn = m.value;
      maxRack = k;
    }
  }
  let alarms = 0;
  for (const e of store.latest.values()) if (e.alarm && e.alarm !== 'normal') alarms++;
  return {
    it: num(a.it_power),
    cooling: num(a.cooling_power),
    facility: num(a.facility_power),
    pue: num(a.pue),
    kwh: num(a.energy_kwh),
    maxIn,
    maxRack,
    margin: maxIn === null ? null : warnIn - maxIn,
    alarms,
  };
}

// 기준과 지금의 차이. good: 값이 줄수록 좋은 항목이 줄었으면 true, 늘었으면 false, 같으면 null
const ITEMS = [
  { key: 'facility', label: '설비 전력', unit: 'kW', digits: 1, goodWhen: 'down' },
  { key: 'cooling', label: '냉각 전력', unit: 'kW', digits: 1, goodWhen: 'down' },
  { key: 'pue', label: 'PUE', unit: '', digits: 2, goodWhen: 'down' },
  { key: 'maxIn', label: '가장 높은 입구 온도', unit: '°C', digits: 1, goodWhen: 'down' },
  { key: 'alarms', label: '알람', unit: '건', digits: 0, goodWhen: 'down' },
];

export function compare(base, now) {
  return ITEMS.map((it) => {
    const b = base[it.key];
    const n = now[it.key];
    const ok = b !== null && n !== null && b !== undefined && n !== undefined;
    const delta = ok ? n - b : null;
    const eps = 0.5 * 10 ** -it.digits;
    const dir = !ok || Math.abs(delta) < eps ? 'same' : delta < 0 ? 'down' : 'up';
    return { ...it, base: ok ? b : null, now: ok ? n : null, delta, pct: ok && b !== 0 ? (delta / b) * 100 : null, dir, good: dir === 'same' ? null : dir === it.goodWhen };
  });
}

// 랙별 여유 전력(정격 - 지금). 여유가 적은 순으로 돌려준다.
export function capacity(store, rackKeys, rated = RATED_KW) {
  const racks = [];
  for (const k of rackKeys) {
    const m = store.metric(k, 'power');
    if (!m || !Number.isFinite(m.value)) continue;
    racks.push({ key: k, kw: m.value, headroom: rated - m.value, pct: (m.value / rated) * 100 });
  }
  racks.sort((a, b) => a.headroom - b.headroom);
  return {
    racks,
    rated,
    totalHeadroom: racks.reduce((s, r) => s + r.headroom, 0),
    near: racks.filter((r) => r.pct >= 90).length,
    over: racks.filter((r) => r.pct > 100).length,
  };
}

// 줄별 가장 높은 입구 온도와 주의 기준까지의 여유, 과냉각 의심 여부(간이)
export function rowInlets(store, rackKeys, rowOf, warnIn = WARN_IN_DEFAULT, margin = OVERCOOL_MARGIN) {
  const byRow = new Map();
  for (const k of rackKeys) {
    const m = store.metric(k, 'temp_in');
    if (!m || !Number.isFinite(m.value)) continue;
    const row = rowOf(k);
    if (byRow.get(row) === undefined || m.value > byRow.get(row)) byRow.set(row, m.value);
  }
  return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, max]) => ({ row, max, margin: warnIn - max, overcooled: warnIn - max >= margin }));
}

// 공급 온도를 올려 볼 수 있는 폭(모델 기준): 가장 높은 입구 온도가 주의 기준에 닿기 전까지. 모델에서 입구 온도는 공급 온도와 같은 폭으로 움직인다고 본다.
export function supplyRoom(maxIn, warnIn = WARN_IN_DEFAULT, safety = 1.5) {
  return maxIn === null ? null : Math.max(0, warnIn - maxIn - safety);
}

// 대응 순서(가상 시설의 예시. 실제 운영 절차가 아니다)
export const RESPONSE = {
  normal: {
    title: '정상 가동',
    steps: ['지금 상태를 "기준으로 저장"해 둔다(에너지·용량 탭).', '시나리오를 바꾸거나 슬라이더를 움직여 본 뒤 기준과 비교한다.', '공급 온도를 올려 보고 냉각 전력과 입구 온도 여유가 어떻게 변하는지 본다.'],
  },
  fan_fault: {
    title: '팬 이상',
    steps: ['알람 탭에서 CRAC_01 팬 속도 알람을 확인한다.', '같은 통로(1·2번 줄)의 가장 높은 입구 온도를 본다.', '같은 통로의 다른 냉각 장치 팬 속도를 올려 본다.', '입구 온도가 주의 기준에 가까우면 그 줄 랙 전력을 낮춰 본다.', '기준과 비교해 입구 온도와 설비 전력이 어떻게 바뀌었는지 확인한다.'],
  },
  cooling_failure: {
    title: '냉각 장치 정지',
    steps: ['알람 탭에서 정지한 냉각 장치와 팬 속도 0%를 확인한다.', '그 장치가 맡은 통로의 입구 온도 상승 속도를 본다.', '짝이 되는 냉각 장치 팬을 100%로 올린다.', '입구 온도가 주의 기준을 넘기 전에 그 통로 줄의 전력을 낮춘다.', '공급 온도를 낮춰 여유를 만들고, 냉각 전력이 얼마나 늘었는지 기준과 비교한다.'],
  },
  power_spike: {
    title: '전력 급증',
    steps: ['알람 탭과 장비 탭에서 전력이 늘어난 줄(2번 줄)을 확인한다.', '에너지·용량 탭에서 랙별 여유 전력이 얼마 남았는지 본다.', '2번 줄 전력 배수를 낮춰 본다.', '가까운 냉각 장치 팬을 올려 입구 온도 상승을 막아 본다.', '기준과 비교해 설비 전력과 입구 온도 변화를 확인한다.'],
  },
};

export function responseFor(name) {
  return RESPONSE[name] ?? { title: name ?? '시나리오', steps: ['이 시나리오에는 아직 안내가 없다. 알람 탭에서 상황을 확인한다.'] };
}
