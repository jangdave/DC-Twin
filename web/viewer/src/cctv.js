// 가상 CCTV (docs/27 10장). 카메라는 랙 배치 파일(scene.json)에서 계산한다. 손으로 좌표를 박지 않으므로 랙을 옮기면 같이 바뀐다.
// 이 화면은 3D 장면에서 만든 가상 화면이며 실제 영상이 아니다. 좌표는 장면 파일 기준(cm, Z 위)이다.

// 화질 단계별 한 번에 보이는 칸 수와 갱신 속도(초당). 실제 기기 측정 전의 시작값이다.
export const CCTV_LIMITS = {
  low: { tiles: 2, fps: 8 },
  mid: { tiles: 4, fps: 12 },
  high: { tiles: 4, fps: 15 },
};

const mid = (a, b) => (a + b) / 2;

// 카메라 목록을 만든다. 각 항목: { id, name, pos:[x,y,z], target:[x,y,z], fov, zone:{rows?, cracs?, all?} }
export function buildCameras(data) {
  const [sx, sy, sz] = data.size;
  const eye = Math.min(sz - 70, 300);
  const rows = new Map();
  for (const r of data.racks) {
    const e = rows.get(r.row) ?? { y0: Infinity, y1: -Infinity };
    e.y0 = Math.min(e.y0, r.min[1]);
    e.y1 = Math.max(e.y1, r.max[1]);
    rows.set(r.row, e);
  }
  const rowNos = [...rows.keys()].sort((a, b) => a - b);
  const racksMinX = Math.min(...data.racks.map((r) => r.min[0]));
  const racksMaxX = Math.max(...data.racks.map((r) => r.max[0]));
  const west = data.cracs.filter((c) => mid(c.min[0], c.max[0]) < sx / 2);
  const east = data.cracs.filter((c) => mid(c.min[0], c.max[0]) >= sx / 2);
  const westEdge = west.length ? Math.max(...west.map((c) => c.max[0])) : 0;
  const eastEdge = east.length ? Math.min(...east.map((c) => c.min[0])) : sx;

  const cams = [{ id: 'entrance', name: '출입구 쪽', pos: [sx / 2, 40, eye], target: [sx / 2, sy * 0.62, 90], fov: 78, zone: { all: true } }];
  // 서로 마주 보는 두 줄(1·2, 3·4, 5·6) 사이의 통로를 한쪽 끝에서 길게 본다
  for (let i = 0; i + 1 < rowNos.length; i += 2) {
    const a = rows.get(rowNos[i]);
    const b = rows.get(rowNos[i + 1]);
    const y = mid(a.y1, b.y0);
    cams.push({ id: `aisle_${rowNos[i]}_${rowNos[i + 1]}`, name: `통로 ${rowNos[i]}·${rowNos[i + 1]}줄`, pos: [Math.max(westEdge + 30, 30), y, eye], target: [racksMaxX, y, 100], fov: 70, zone: { rows: [rowNos[i], rowNos[i + 1]] } });
  }
  if (west.length) cams.push({ id: 'crac_west', name: '냉각 장치 서쪽', pos: [westEdge + 380, sy / 2, eye], target: [Math.min(...west.map((c) => c.min[0])) + 50, sy / 2, 110], fov: 82, zone: { cracs: west.map((c) => c.name) } });
  if (east.length) cams.push({ id: 'crac_east', name: '냉각 장치 동쪽', pos: [eastEdge - 380, sy / 2, eye], target: [Math.max(...east.map((c) => c.max[0])) - 50, sy / 2, 110], fov: 82, zone: { cracs: east.map((c) => c.name) } });
  cams.push({ id: 'ceiling', name: '천장 전체', pos: [sx / 2, sy / 2, sz + 560], target: [sx / 2, sy / 2, 0], fov: 55, zone: { all: true } });
  return cams;
}

// 알람이 난 줄 번호와 냉각 장치 이름. worst(key)는 'normal' | 'warn' | 'critical' 중 하나를 돌려준다.
export function alarmSets(data, worst, keyOf = (n) => n.toLowerCase()) {
  const rows = new Set();
  const cracs = new Set();
  const all = { any: false };
  for (const r of data.racks) if (worst(keyOf(r.name)) !== 'normal') { rows.add(r.row); all.any = true; }
  for (const c of data.cracs) if (worst(keyOf(c.name)) !== 'normal') { cracs.add(c.name); all.any = true; }
  return { rows, cracs, any: all.any };
}

export function zoneAlarmed(cam, sets) {
  const z = cam.zone;
  if (z.all) return sets.any;
  if (z.rows) return z.rows.some((r) => sets.rows.has(r));
  if (z.cracs) return z.cracs.some((n) => sets.cracs.has(n));
  return false;
}

// 알람 구역을 앞으로 보내고 나머지는 원래 순서를 지킨다
export function orderCameras(cams, sets) {
  const hot = cams.filter((c) => zoneAlarmed(c, sets) && !c.zone.all);
  const rest = cams.filter((c) => !hot.includes(c));
  return [...hot, ...rest];
}

// 쪽 번호로 보일 카메라를 자른다(끝을 넘으면 처음으로)
export function pageOf(cams, tiles, page) {
  if (cams.length === 0) return [];
  const pages = Math.ceil(cams.length / tiles);
  const p = ((page % pages) + pages) % pages;
  return cams.slice(p * tiles, p * tiles + tiles);
}
