// 데이터센터 주변 도심 (docs/23, docs/26). 외부 에셋 없이 건물, 공원, 주차장, 도로, 횡단보도, 가로등, 가로수, 차량을 코드로 만든다.
// 가상의 도시이며 실제 지역이 아니다.
//   planCity: 배치만 계산(순수 함수, 시험 가능). buildCity: three.js 객체를 만든다.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FACADE_TILE, ROOF_UV, facadeTextures, grassTexture, lotTexture, mulberry32, roadTexture, sidewalkTexture, skylineTexture } from './citytex.js';

export const CITY = {
  pitchX: 210, // 블록 중심 간격(m). 가운데 블록에 데이터센터 부지(약 130 x 105 m)가 들어간다
  pitchZ: 185,
  road: 20, // 도로 폭
};
// 데이터센터 부지(건물 glb의 울타리 안쪽, m). 정문은 남쪽(+z) 가운데에 있다.
export const SITE = { hw: 65.05, hd: 52.65, gateW: 12 };
const SIDEWALK = 9; // 블록 가장자리 인도 폭
const LAWN_GAP = 1.5; // 울타리와 잔디 사이
export const FACADES = Object.keys(FACADE_TILE);
export const baseFacade = (f) => f.replace('2', '');
// 외벽 종류마다 색 팔레트(그림 색에 곱한다). 같은 외벽이라도 건물마다 다른 색으로 보이게 한다.
export const PALETTES = {
  glass: [[1, 1, 1], [0.7, 1, 0.92], [1, 0.82, 0.62], [0.78, 0.84, 1], [0.8, 0.9, 0.92]],
  ribbon: [[1, 1, 1], [1, 0.9, 0.78], [0.82, 0.9, 1], [0.78, 0.78, 0.82], [1, 0.82, 0.78]],
  concrete: [[1, 1, 1], [1.05, 0.94, 0.8], [0.8, 0.82, 0.86], [1.05, 0.82, 0.74], [0.68, 0.7, 0.72]],
  brick: [[1, 1, 1], [0.78, 0.68, 0.62], [1.12, 1.0, 0.85], [1, 0.82, 0.68], [0.88, 0.78, 0.84]],
  metal: [[1, 1, 1], [0.78, 0.84, 0.96], [1.05, 0.93, 0.76], [0.62, 0.66, 0.72], [0.82, 1, 0.9]],
};

const pick = (rng, table) => {
  let r = rng() * table.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of table) if ((r -= w) <= 0) return v;
  return table[table.length - 1][0];
};

// 블록(또는 그 일부)을 2~6개 필지로 나눈다. 긴 쪽을 38~62% 지점에서 자른다.
function splitParcels(rng, x0, z0, w, d, depth = 0) {
  const small = w < 52 || d < 52;
  if (small || w * d < 2600 || depth >= 3 || (depth >= 1 && rng() < 0.28)) return [{ x: x0, z: z0, w, d }];
  const t = 0.38 + rng() * 0.24;
  if (w >= d) {
    const w1 = w * t;
    return [...splitParcels(rng, x0 - w / 2 + w1 / 2, z0, w1, d, depth + 1), ...splitParcels(rng, x0 + w / 2 - (w - w1) / 2, z0, w - w1, d, depth + 1)];
  }
  const d1 = d * t;
  return [...splitParcels(rng, x0, z0 - d / 2 + d1 / 2, w, d1, depth + 1), ...splitParcels(rng, x0, z0 + d / 2 - (d - d1) / 2, w, d - d1, depth + 1)];
}

const KINDS = {
  1: [['box', 0.42], ['podium', 0.2], ['stepped', 0.2], ['lshape', 0.18]],
  2: [['box', 0.2], ['podium', 0.28], ['stepped', 0.2], ['lshape', 0.14], ['tower', 0.18]],
  3: [['box', 0.1], ['podium', 0.24], ['stepped', 0.18], ['lshape', 0.1], ['tower', 0.38]],
};
const HEIGHT = {
  1: { box: [9, 24], podium: [16, 30], stepped: [18, 32], lshape: [12, 24], tower: [30, 40] },
  2: { box: [20, 40], podium: [30, 68], stepped: [30, 60], lshape: [22, 46], tower: [55, 90] },
  3: { box: [24, 50], podium: [45, 110], stepped: [40, 90], lshape: [30, 60], tower: [80, 170] },
};
const FACADE_BY_KIND = {
  tower: [['glass', 0.55], ['ribbon', 0.3], ['metal', 0.15]],
  podium: [['glass', 0.35], ['ribbon', 0.35], ['metal', 0.15], ['concrete', 0.15]],
  stepped: [['concrete', 0.3], ['ribbon', 0.25], ['glass', 0.25], ['metal', 0.2]],
  box: [['concrete', 0.35], ['brick', 0.3], ['ribbon', 0.2], ['metal', 0.15]],
  lshape: [['brick', 0.3], ['concrete', 0.3], ['ribbon', 0.2], ['glass', 0.2]],
};

// 필지 안의 건물 한 동을 상자 여러 개(parts)로 만든다. 모두 필지 안에 있고 서로 겹치지 않거나 위로 쌓인다.
function makeBuilding(rng, p, ring) {
  const kind = pick(rng, KINDS[Math.min(ring, 3)]);
  const [lo, hi] = HEIGHT[Math.min(ring, 3)][kind];
  let H = lo + rng() * (hi - lo);
  if (kind === 'tower' && ring === 3 && rng() < 0.1) H = 175 + rng() * 40; // 랜드마크
  const { x: cx, z: cz, w: fw, d: fd } = p;
  const parts = [];
  if (kind === 'box') {
    parts.push({ x: cx, z: cz, w: fw, d: fd, y0: 0, h: H });
  } else if (kind === 'podium') {
    const bh = Math.min(7 + rng() * 7, H * 0.5);
    parts.push({ x: cx, z: cz, w: fw, d: fd, y0: 0, h: bh });
    const tw = fw * (0.5 + rng() * 0.25), td = fd * (0.5 + rng() * 0.25);
    parts.push({ x: cx + ((fw - tw) / 2) * (rng() * 1.6 - 0.8), z: cz + ((fd - td) / 2) * (rng() * 1.6 - 0.8), w: tw, d: td, y0: bh, h: H - bh });
  } else if (kind === 'stepped') {
    const scales = [1, 0.76, 0.54];
    const shares = [0.45, 0.3, 0.25];
    let y = 0;
    scales.forEach((s, i) => {
      const w = fw * s, d = fd * s;
      const h = H * shares[i];
      parts.push({ x: cx + ((fw - w) / 2) * (rng() * 0.6 - 0.3), z: cz + ((fd - d) / 2) * (rng() * 0.6 - 0.3), w, d, y0: y, h });
      y += h;
    });
  } else if (kind === 'lshape') {
    const sgn = rng() < 0.5 ? -1 : 1;
    parts.push({ x: cx, z: cz - fd / 4, w: fw, d: fd / 2, y0: 0, h: H });
    parts.push({ x: cx + (sgn * fw) / 4, z: cz + fd / 4, w: fw / 2, d: fd / 2, y0: 0, h: H * (0.55 + rng() * 0.35) });
  } else {
    const tw = fw * (0.45 + rng() * 0.2), td = fd * (0.45 + rng() * 0.2);
    let y = 0;
    if (rng() < 0.3) {
      parts.push({ x: cx, z: cz, w: fw, d: fd, y0: 0, h: 6 });
      y = 6;
    }
    parts.push({ x: cx, z: cz, w: tw, d: td, y0: y, h: H - y });
    parts.push({ x: cx, z: cz, w: tw * 0.7, d: td * 0.7, y0: H, h: 3 + rng() * 5 }); // 꼭대기 설비층
  }
  // 옥상 설비: 가장 높은 상자 위에 작은 상자 몇 개와 높은 건물의 안테나
  const top = parts.reduce((a, q) => (q.y0 + q.h > a.y0 + a.h ? q : a), parts[0]);
  const roof = [];
  const n = top.w > 9 && top.d > 9 ? 1 + Math.floor(rng() * 3) : 0;
  for (let i = 0; i < n; i++) {
    const w = 2 + rng() * 4, d = 2 + rng() * 4, h = 1.5 + rng() * 2;
    roof.push({ x: top.x + (top.w / 2 - w / 2 - 1) * (rng() * 2 - 1), z: top.z + (top.d / 2 - d / 2 - 1) * (rng() * 2 - 1), w, d, y0: top.y0 + top.h, h });
  }
  const topY = Math.max(...parts.map((q) => q.y0 + q.h));
  if (topY > 90 && rng() < 0.5) roof.push({ x: top.x, z: top.z, w: 0.7, d: 0.7, y0: top.y0 + top.h, h: 10 + rng() * 8 });
  const facade = pick(rng, FACADE_BY_KIND[kind]) + (rng() < 0.5 ? '2' : '');
  return { kind, facade, pal: Math.floor(rng() * 5), h: topY, parts, roof };
}

// 블록마다 필지로 나누고 공원, 주차장, 건물을 놓는다. 가운데 블록(0,0)은 비운다.
export function planCity({ cx, cz, rings, seed = 11 }) {
  const rng = mulberry32(seed);
  const bw = CITY.pitchX - CITY.road;
  const bd = CITY.pitchZ - CITY.road;
  const blocks = [], buildings = [], parks = [], lots = [], trees = [];
  for (let i = -rings; i <= rings; i++) {
    for (let j = -rings; j <= rings; j++) {
      if (i === 0 && j === 0) continue;
      const ring = Math.max(Math.abs(i), Math.abs(j));
      const bx = cx + i * CITY.pitchX;
      const bz = cz + j * CITY.pitchZ;
      blocks.push({ i, j, ring, x: bx, z: bz, w: bw, d: bd });
      for (const parcel of splitParcels(rng, bx, bz, bw, bd)) {
        const r = rng();
        if (r < 0.07) {
          parks.push({ ...parcel, ring });
          const count = Math.floor((parcel.w * parcel.d) / 120);
          for (let k = 0; k < count; k++) trees.push([parcel.x + (rng() - 0.5) * (parcel.w - 6), parcel.z + (rng() - 0.5) * (parcel.d - 6)]);
          continue;
        }
        if (r < 0.12) {
          lots.push({ ...parcel, ring });
          continue;
        }
        const setback = 2 + rng() * 4;
        const fp = { x: parcel.x, z: parcel.z, w: parcel.w - setback * 2, d: parcel.d - setback * 2 };
        if (fp.w < 14 || fp.d < 14) continue;
        const b = makeBuilding(rng, fp, ring);
        buildings.push({ ...b, x: fp.x, z: fp.z, w: fp.w, d: fp.d, tint: rng(), uvSeed: rng(), ring });
      }
    }
  }
  // 도로 띠: 블록 사이. 동서 방향(z 고정)과 남북 방향(x 고정)
  const roads = [];
  const lenX = (2 * rings + 2) * CITY.pitchX;
  const lenZ = (2 * rings + 2) * CITY.pitchZ;
  for (let j = -rings - 1; j <= rings; j++) roads.push({ dir: 'x', x: cx, z: cz + (j + 0.5) * CITY.pitchZ, len: lenX });
  for (let i = -rings - 1; i <= rings; i++) roads.push({ dir: 'z', x: cx + (i + 0.5) * CITY.pitchX, z: cz, len: lenZ });
  // 가로수: 블록 가장자리(인도 위)를 따라 16 m 간격
  for (const b of blocks) {
    const m = 3;
    for (let t = -b.w / 2 + 8; t < b.w / 2; t += 16) trees.push([b.x + t, b.z - b.d / 2 + m], [b.x + t, b.z + b.d / 2 - m]);
    for (let t = -b.d / 2 + 8; t < b.d / 2; t += 16) trees.push([b.x - b.w / 2 + m, b.z + t], [b.x + b.w / 2 - m, b.z + t]);
  }
  // 가로등: 도로 양쪽 인도 가장자리, 38 m 간격
  const lamps = [];
  for (const r of roads) {
    const off = CITY.road / 2 + 1.4;
    for (let t = -r.len / 2 + 19; t < r.len / 2; t += 38) {
      if (r.dir === 'x') lamps.push([r.x + t, r.z - off], [r.x + t + 19, r.z + off]);
      else lamps.push([r.x - off, r.z + t], [r.x + off, r.z + t + 19]);
    }
  }
  // 횡단보도: 교차로 네 방향, 도로 폭을 가로지르는 줄무늬
  const crosswalks = [];
  const xRoads = roads.filter((r) => r.dir === 'x');
  const zRoads = roads.filter((r) => r.dir === 'z');
  for (const rx of xRoads) {
    for (const rz of zRoads) {
      const ix = rz.x, iz = rx.z;
      const off = CITY.road / 2 + 1.6;
      for (let k = -6; k <= 6; k++) {
        const s = k * 1.35;
        crosswalks.push({ x: ix - off, z: iz + s, w: 3.2, d: 0.7 }, { x: ix + off, z: iz + s, w: 3.2, d: 0.7 });
        crosswalks.push({ x: ix + s, z: iz - off, w: 0.7, d: 3.2 }, { x: ix + s, z: iz + off, w: 0.7, d: 3.2 });
      }
    }
  }
  // 도로 조각: 교차로 정사각형을 비우고 그 사이만 잇는다(겹치는 면이 없어 깜빡이지 않는다). 교차로는 따로 칠한다.
  const roadSegments = [];
  const intersections = [];
  const halfRoad = CITY.road / 2;
  for (const rx of xRoads) for (const rz of zRoads) intersections.push({ x: rz.x, z: rx.z });
  const cut = (r, cross, key) => {
    const edges = [-r.len / 2];
    for (const c of cross) edges.push(c[key] - (key === 'x' ? r.x : r.z) - halfRoad, c[key] - (key === 'x' ? r.x : r.z) + halfRoad);
    edges.push(r.len / 2);
    for (let i = 0; i < edges.length; i += 2) {
      const len = edges[i + 1] - edges[i];
      if (len < 0.5) continue;
      const mid = (edges[i] + edges[i + 1]) / 2;
      roadSegments.push(r.dir === 'x' ? { dir: 'x', x: r.x + mid, z: r.z, len } : { dir: 'z', x: r.x, z: r.z + mid, len });
    }
  };
  for (const r of xRoads) cut(r, zRoads.slice().sort((a, b) => a.x - b.x), 'x');
  for (const r of zRoads) cut(r, xRoads.slice().sort((a, b) => a.z - b.z), 'z');

  // 가운데 블록: 가장자리 인도 띠, 울타리 둘레 잔디, 정문(남쪽)에서 도로로 이어지는 진입로(인도는 진입로 앞에서 끊는다)
  const gw = SITE.gateW / 2;
  const ix0 = bw / 2 - SIDEWALK; // 인도 안쪽 경계
  const iz0 = bd / 2 - SIDEWALK;
  const lx = SITE.hw + LAWN_GAP; // 잔디가 시작하는 곳(울타리 바깥)
  const lz = SITE.hd + LAWN_GAP;
  const R = (x0, x1, z0, z1) => ({ x: cx + (x0 + x1) / 2, z: cz + (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 });
  const apron = {
    sidewalks: [
      R(-bw / 2, bw / 2, -bd / 2, -iz0), // 북
      R(-bw / 2, -gw - 2, iz0, bd / 2), R(gw + 2, bw / 2, iz0, bd / 2), // 남(진입로 앞이 열림)
      R(-bw / 2, -ix0, -iz0, iz0), R(ix0, bw / 2, -iz0, iz0), // 서, 동
    ],
    lawns: [
      R(-ix0, -lx, -iz0, iz0), R(lx, ix0, -iz0, iz0), // 서, 동
      R(-lx, lx, -iz0, -lz), // 북
      R(-lx, -gw, lz, iz0), R(gw, lx, lz, iz0), // 남(진입로 양쪽)
    ],
    drive: R(-gw, gw, SITE.hd, bd / 2),
  };
  // 잔디 둘레 나무
  for (let t = -ix0 + 6; t < ix0; t += 14) {
    trees.push([cx + t, cz - iz0 + 4], [cx - ix0 + 4, cz + t * (iz0 / ix0)], [cx + ix0 - 4, cz + t * (iz0 / ix0)]);
    if (Math.abs(t) > gw + 6) trees.push([cx + t, cz + iz0 - 4]);
  }
  return { blocks, buildings, parks, lots, roads, roadSegments, intersections, apron, trees: clearTrees(trees, buildings), lamps, crosswalks };
}

// 나무 수관의 가장 큰 반지름(m). 이보다 건물 가까이에 있는 나무는 건물을 뚫고 나오므로 뺀다.
export const TREE_CLEAR = 3.4;
const TREE_GAP = 3; // 나무끼리 최소 간격(m)
// 건물(모든 부분 상자)과 수관이 겹치는 나무를 빼고, 너무 붙은 나무는 하나만 남긴다. 건물 배치는 바꾸지 않는다.
export function clearTrees(trees, buildings, clear = TREE_CLEAR, gap = TREE_GAP) {
  const boxes = buildings.flatMap((b) => b.parts);
  const free = trees.filter(([x, z]) => !boxes.some((q) => Math.abs(x - q.x) < q.w / 2 + clear && Math.abs(z - q.z) < q.d / 2 + clear));
  const cell = new Map();
  const out = [];
  for (const t of free) {
    const kx = Math.floor(t[0] / gap), kz = Math.floor(t[1] / gap);
    let ok = true;
    for (let i = -1; i <= 1 && ok; i++) for (let j = -1; j <= 1 && ok; j++) for (const u of cell.get(`${kx + i},${kz + j}`) ?? []) if (Math.hypot(u[0] - t[0], u[1] - t[1]) < gap) { ok = false; break; }
    if (!ok) continue;
    out.push(t);
    const key = `${kx},${kz}`;
    if (!cell.has(key)) cell.set(key, []);
    cell.get(key).push(t);
  }
  return out;
}

// ---- 형상 ----
// 상자 한 개: 창 무늬가 크기에 맞게 반복되도록 uv를 키우고, 지붕은 흰 점을 가리켜 색으로만 칠한다.
function boxGeometry(q, b) {
  const g = new THREE.BoxGeometry(q.w, q.h, q.d);
  g.translate(q.x, 0.25 + q.y0 + q.h / 2, q.z);
  const { tw, th, cols } = FACADE_TILE[b.facade];
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const ou = Math.floor(b.uvSeed * 4) / 4;
  const ov = Math.floor((b.uvSeed * 16) % 4) / 4;
  const sides = [q.d / tw, q.d / tw, 0, 0, q.w / tw, q.w / tw];
  const t = 0.8 + 0.28 * b.tint;
  const warm = PALETTES[baseFacade(b.facade)][b.pal];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const n = f * 4 + k;
      if (f === 2 || f === 3) {
        // 지붕과 바닥: 흰 점. 네 꼭짓점이 같은 UV면 화면 기울기(미분)가 0이라 법선 지도의 접선이 깨져 잡음이 난다 -> 점 안(0.982~0.988)에서 위치에 따라 아주 조금만 퍼뜨린다.
        uv.setXY(n, ROOF_UV + ((pos.getX(n) - q.x) / q.w) * 0.006, ROOF_UV + ((pos.getZ(n) - q.z) / q.d) * 0.006);
        const roof = f === 2 ? 0.52 : 0.3;
        col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = roof;
      } else {
        uv.setXY(n, Math.round(uv.getX(n) * sides[f] * cols) / cols + ou, (uv.getY(n) * q.h) / th + ov);
        const ratio = (pos.getY(n) - 0.25 - q.y0) / q.h; // 0 바닥, 1 위
        const ao = q.y0 === 0 ? 0.68 + 0.32 * Math.min(ratio * (q.h / 12) + 0.15, 1) : 1; // 바닥 가까이 어둡게
        col[n * 3] = t * warm[0] * ao;
        col[n * 3 + 1] = t * warm[1] * ao;
        col[n * 3 + 2] = t * warm[2] * ao;
      }
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function roofBoxGeometry(r, tint) {
  const g = new THREE.BoxGeometry(r.w, r.h, r.d);
  g.translate(r.x, 0.25 + r.y0 + r.h / 2, r.z);
  g.deleteAttribute('uv');
  const c = new Float32Array(g.attributes.position.count * 3).fill(0.42 + 0.2 * tint);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function flatRects(rects, y, tile) {
  const geos = rects.map((r) => {
    const g = new THREE.PlaneGeometry(r.w, r.d);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) * r.w) / tile, (uv.getY(k) * r.d) / tile);
    g.translate(r.x, y, r.z);
    return g;
  });
  return mergeGeometries(geos, false);
}

export function buildCity({ cx, cz, quality, seed = 11 }) {
  const plan = planCity({ cx, cz, rings: quality.cityRings, seed });
  const group = new THREE.Group();
  const disposables = [];
  const track = (o) => (disposables.push(o), o);
  const mesh = (geo, mat, receive = false) => {
    const m = new THREE.Mesh(track(geo), track(mat));
    m.receiveShadow = receive;
    group.add(m);
    return m;
  };

  // 건물: 외벽 5종 x 재질 하나씩, 한 종류당 한 덩어리
  const ks = quality.texScale ?? 1; // 그림 배율(낮음 1, 보통 2, 높음 4)
  const tex = facadeTextures(5, ks);
  const mats = {};
  const byFacade = Object.fromEntries(FACADES.map((f) => [f, []]));
  for (const f of FACADES) {
    track(tex[f].map);
    track(tex[f].glow);
    if (tex[f].normal) track(tex[f].normal);
    const base = { map: tex[f].map, emissiveMap: tex[f].glow, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.05, vertexColors: true };
    if (tex[f].normal) Object.assign(base, { normalMap: tex[f].normal, normalScale: new THREE.Vector2(0.7, 0.7) });
    const glassy = baseFacade(f) === 'glass';
    const metal = baseFacade(f) === 'metal';
    // 유리는 반사가 강한 짙은 유리, 금속은 반사가 중간. 콘크리트, 벽돌, 띠창은 반사하지 않는 면(보는 각도에 따라 색이 변하지 않음)
    mats[f] = glassy ? new THREE.MeshStandardMaterial({ ...base, roughness: 0.08, metalness: 0.45 })
      : metal ? new THREE.MeshStandardMaterial({ ...base, roughness: 0.4, metalness: 0.5 })
      : new THREE.MeshLambertMaterial(base);
  }
  const roofGeos = [];
  for (const b of plan.buildings) {
    for (const q of b.parts) byFacade[b.facade].push(boxGeometry(q, b));
    for (const r of b.roof) roofGeos.push(roofBoxGeometry(r, b.tint));
  }
  for (const f of FACADES) if (byFacade[f].length) mesh(mergeGeometries(byFacade[f], false), mats[f]);
  if (roofGeos.length) mesh(mergeGeometries(roofGeos, false), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const emissiveMats = Object.values(mats);

  // 인도 판(블록마다), 공원(잔디), 주차장
  const gt = (t) => { track(t); if (t.userData.normalMap) track(t.userData.normalMap); return t; }; // 바닥 그림과 법선 지도를 함께 정리 대상으로
  const mat = (t, extra = {}) => new THREE.MeshLambertMaterial({ map: t, ...(t.userData.normalMap ? { normalMap: t.userData.normalMap, normalScale: new THREE.Vector2(0.8, 0.8) } : {}), ...extra });
  const sw = gt(sidewalkTexture(ks));
  const slabs = [...plan.blocks.filter(() => true), ...plan.apron.sidewalks].map((b) => {
    const g = new THREE.BoxGeometry(b.w, 0.25, b.d);
    const uv = g.attributes.uv;
    for (let k = 8; k < 12; k++) uv.setXY(k, (uv.getX(k) * b.w) / 8, (uv.getY(k) * b.d) / 8); // 윗면만 8 m 마다 반복
    g.translate(b.x, 0.125, b.z);
    return g;
  });
  mesh(mergeGeometries(slabs, false), mat(sw), true);
  mesh(flatRects(plan.apron.lawns, 0.12, 6), mat(gt(grassTexture(ks))), true);
  mesh(flatRects([plan.apron.drive], 0.14, 16), new THREE.MeshLambertMaterial({ color: 0x3b3d41 }), true);
  if (plan.parks.length) mesh(flatRects(plan.parks, 0.4, 6), mat(gt(grassTexture(ks))), true);
  if (plan.lots.length) mesh(flatRects(plan.lots, 0.4, 16), mat(gt(lotTexture(ks))), true);

  // 도로와 횡단보도
  const rt = gt(roadTexture(ks));
  const strips = plan.roadSegments.map((r) => {
    const g = new THREE.PlaneGeometry(CITY.road, r.len);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * (r.len / 16));
    if (r.dir === 'x') g.rotateY(Math.PI / 2);
    g.translate(r.x, 0.1, r.z); // 모든 도로 조각은 같은 높이이고 서로 겹치지 않는다
    return g;
  });
  mesh(mergeGeometries(strips, false), mat(rt));
  mesh(flatRects(plan.intersections.map((i) => ({ x: i.x, z: i.z, w: CITY.road, d: CITY.road })), 0.1, 16), new THREE.MeshLambertMaterial({ color: 0x3b3d41 }));
  const zebra = plan.crosswalks.map((r) => {
    const g = new THREE.PlaneGeometry(r.w, r.d);
    g.rotateX(-Math.PI / 2);
    g.translate(r.x, 0.2, r.z);
    return g;
  });
  mesh(mergeGeometries(zebra, false), new THREE.MeshLambertMaterial({ color: 0xdfe1e3, polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -6 }));

  // 가로수와 가로등(인스턴스)
  const rng = mulberry32(seed + 3);
  const nTree = Math.min(quality.trees, plan.trees.length);
  let trees = null;
  if (nTree > 0) {
    const chosen = plan.trees.slice().sort(() => rng() - 0.5).slice(0, nTree);
    // 활엽수(둥근 덩어리 셋)와 침엽수(원뿔 셋)를 섞는다. 꼭짓점 색을 아래는 어둡게 위는 밝게 칠해 한 덩어리로 보이지 않게 한다.
    const trunkG = track(new THREE.CylinderGeometry(0.2, 0.32, 3.2, 8).translate(0, 1.6, 0));
    const shade = (g, lo = 0.6, hi = 1.0) => {
      g.computeBoundingBox();
      const { min, max } = g.boundingBox;
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) col.fill(lo + (hi - lo) * ((pos.getY(i) - min.y) / (max.y - min.y)), i * 3, i * 3 + 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    };
    const jr = mulberry32(seed + 9);
    const lump = (r, x, y, z) => {
      const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
      const p = g.attributes.position;
      const k = new Map(); // 같은 꼭짓점은 같이 움직여 틈이 생기지 않게
      for (let i = 0; i < p.count; i++) {
        const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
        if (!k.has(key)) k.set(key, 0.82 + jr() * 0.36);
        const f = k.get(key);
        p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.92, p.getZ(i) * f);
      }
      return g.translate(x, y, z);
    };
    const broadG = track(shade(mergeGeometries([lump(2.0, 0, 4.7, 0), lump(1.5, 1.1, 4.0, 0.5), lump(1.4, -1.0, 4.2, -0.6), lump(1.2, 0.2, 5.9, -0.2)])));
    const coneG = track(shade(mergeGeometries([new THREE.ConeGeometry(2.2, 3.0, 8).translate(0, 3.9, 0).toNonIndexed(), new THREE.ConeGeometry(1.7, 2.6, 8).translate(0, 5.5, 0).toNonIndexed(), new THREE.ConeGeometry(1.2, 2.3, 8).translate(0, 6.9, 0).toNonIndexed()]), 0.55, 1.1));
    const species = chosen.map(() => (rng() < 0.3 ? 1 : 0));
    const nCone = species.reduce((a, v) => a + v, 0);
    const leaf = () => track(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true }));
    const trunk = new THREE.InstancedMesh(trunkG, track(new THREE.MeshLambertMaterial({ color: 0x4a3524 })), nTree);
    const crown = new THREE.InstancedMesh(broadG, leaf(), nTree - nCone);
    const conifer = new THREE.InstancedMesh(coneG, leaf(), Math.max(nCone, 1));
    conifer.count = nCone;
    const tm = new THREE.Matrix4(), c = new THREE.Color();
    let ib = 0, ic = 0;
    chosen.forEach(([x, z], k) => {
      const s = 0.75 + rng() * 0.7;
      tm.compose(new THREE.Vector3(x, 0.25, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6), new THREE.Vector3(s, s * (0.9 + rng() * 0.4), s));
      trunk.setMatrixAt(k, tm);
      if (species[k]) {
        conifer.setMatrixAt(ic, tm);
        conifer.setColorAt(ic++, c.setHSL(0.36 + rng() * 0.05, 0.35 + rng() * 0.15, 0.14 + rng() * 0.08));
      } else {
        crown.setMatrixAt(ib, tm);
        crown.setColorAt(ib++, c.setHSL(0.19 + rng() * 0.12, 0.42 + rng() * 0.2, 0.2 + rng() * 0.12));
      }
    });
    trees = new THREE.Group();
    trees.add(trunk, crown, conifer);
    group.add(trees);
  }
  let lampHeads = null;
  let lampPoles = null;
  const nLamp = Math.min(Math.floor(quality.trees * 0.6), plan.lamps.length);
  if (nLamp > 0) {
    const chosen = plan.lamps.slice().sort(() => rng() - 0.5).slice(0, nLamp);
    const poleG = track(new THREE.CylinderGeometry(0.1, 0.14, 8.5, 6).translate(0, 4.25, 0));
    const headG = track(new THREE.BoxGeometry(1.8, 0.25, 0.55).translate(0, 8.55, 0));
    lampPoles = new THREE.InstancedMesh(poleG, track(new THREE.MeshLambertMaterial({ color: 0x3a3f45 })), nLamp);
    lampHeads = new THREE.InstancedMesh(headG, track(new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: new THREE.Color(0xffe2a8), emissiveIntensity: 0 })), nLamp);
    const lm = new THREE.Matrix4();
    chosen.forEach(([x, z], k) => {
      lm.makeTranslation(x, 0.25, z);
      lampPoles.setMatrixAt(k, lm);
      lampHeads.setMatrixAt(k, lm);
    });
    group.add(lampPoles, lampHeads);
  }

  // 먼 도시: 정밀한 도시 블록 바깥(바닥 원판 반지름 1100 m 안)을 단순한 상자 건물로 채워, 낮은 각도로 멀리 볼 때
  // 도시가 끝나고 빈 회색 바닥이 보이는 어색함을 없앤다. 한 덩어리 메시이고 창 그림이 없으며 안개에 묻힌다.
  {
    const far = [];
    const fr = mulberry32(seed + 21);
    const maxRing = 5;
    const bwid = CITY.pitchX - CITY.road, bdep = CITY.pitchZ - CITY.road;
    const farCol = new THREE.Color();
    for (let i = -maxRing; i <= maxRing; i++) {
      for (let j = -maxRing; j <= maxRing; j++) {
        const ring = Math.max(Math.abs(i), Math.abs(j));
        if (ring <= quality.cityRings) continue;
        const bx = cx + i * CITY.pitchX, bz = cz + j * CITY.pitchZ;
        const nx = 3, nz = 2; // 블록 하나를 3 x 2 필지로
        for (let a = 0; a < nx; a++) {
          for (let b = 0; b < nz; b++) {
            if (fr() < 0.12) continue;
            const w = (bwid / nx) * (0.6 + fr() * 0.3), d = (bdep / nz) * (0.6 + fr() * 0.3);
            const h = (ring < 5 ? 18 : 12) + fr() * (fr() < 0.2 ? 90 : 38);
            const g = new THREE.BoxGeometry(w, h, d);
            g.translate(bx - bwid / 2 + (a + 0.5) * (bwid / nx), h / 2, bz - bdep / 2 + (b + 0.5) * (bdep / nz));
            const n = g.attributes.position.count;
            const col = new Float32Array(n * 3);
            const tone = 0.42 + fr() * 0.3;
            farCol.setRGB(tone * (0.92 + fr() * 0.1), tone, tone * (1.0 + fr() * 0.12));
            for (let k = 0; k < n; k++) { // 윗면은 조금 밝게
              const up = g.attributes.normal.getY(k) > 0.5 ? 1.18 : 1;
              col[k * 3] = farCol.r * up; col[k * 3 + 1] = farCol.g * up; col[k * 3 + 2] = farCol.b * up;
            }
            g.setAttribute('color', new THREE.BufferAttribute(col, 3));
            g.deleteAttribute('uv');
            far.push(g);
          }
        }
      }
    }
    if (far.length) {
      const m = new THREE.Mesh(track(mergeGeometries(far)), track(new THREE.MeshLambertMaterial({ vertexColors: true })));
      far.forEach((g) => g.dispose());
      group.add(m);
    }
  }

  // 먼 도시 윤곽(원통 안쪽에 두른 그림). 안개에 묻혀 멀리 보인다.
  const sk = track(skylineTexture());
  const skyline = new THREE.Mesh(track(new THREE.CylinderGeometry(1250, 1250, 256, 64, 1, true)), track(new THREE.MeshBasicMaterial({ map: sk, transparent: true, alphaTest: 0.5, side: THREE.BackSide, depthWrite: false })));
  skyline.scale.x = -1;
  skyline.position.set(cx, 108, cz);
  skyline.renderOrder = -0.5;
  group.add(skyline);

  // 차량(인스턴스, 도로를 따라 움직임). 승용차와 승합차 두 종류: 차체, 유리창, 바퀴, 앞뒤 등을 한 덩어리로 합친다.
  // 차체는 차마다 다른 색(인스턴스 색), 유리와 바퀴는 어두운 고정 색(꼭짓점 색). 앞뒤 등은 따로 그려서 저녁에 밝아진다.
  const cars = [];
  const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const nCar = quality.cars;
  const carState = [];
  const carType = (spec) => {
    const part = (g, rgb) => {
      const n = g.attributes.position.count;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => rgb[i % 3]), 3));
      return g;
    };
    const bx = (w, h, d, x, y, z, rgb) => part(new THREE.BoxGeometry(w, h, d).translate(x, y, z), rgb);
    const taper = (g, k) => { // 윗면을 앞뒤로 좁혀 앞유리, 뒷유리 기울기를 만든다
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > g.boundingBox.min.y + 0.01 + (g.boundingBox.max.y - g.boundingBox.min.y) / 2) p.setX(i, p.getX(i) * k);
      return g;
    };
    const L = spec.len, W = 1.9, glass = [0.1, 0.14, 0.2], dark = [0.06, 0.06, 0.07], white = [1, 1, 1];
    const body = [bx(L, 0.62, W, 0, 0.66, 0, white)];
    const cab = new THREE.BoxGeometry(spec.cabLen, spec.cabH, W - 0.12).translate(spec.cabX, 0.97 + spec.cabH / 2, 0);
    cab.computeBoundingBox();
    body.push(part(taper(cab, spec.taper), glass));
    body.push(bx(spec.cabLen * spec.taper * 0.98, 0.08, W - 0.1, spec.cabX, 0.97 + spec.cabH + 0.02, 0, white)); // 지붕
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.push(part(new THREE.CylinderGeometry(0.38, 0.38, 0.26, 10).rotateX(Math.PI / 2).translate(sx * (L / 2 - 0.85), 0.38, sz * (W / 2 - 0.05)), dark));
    body.push(bx(0.1, 0.18, W - 0.2, L / 2 + 0.02, 0.5, 0, dark), bx(0.1, 0.18, W - 0.2, -L / 2 - 0.02, 0.5, 0, dark)); // 범퍼
    const lights = [];
    for (const sz of [-1, 1]) {
      lights.push(bx(0.08, 0.2, 0.42, L / 2 + 0.06, 0.78, sz * 0.66, [1, 0.95, 0.75])); // 앞등
      lights.push(bx(0.08, 0.16, 0.4, -L / 2 - 0.06, 0.8, sz * 0.68, [0.9, 0.08, 0.06])); // 뒷등
    }
    return { body: track(mergeGeometries(body)), lights: track(mergeGeometries(lights)) };
  };
  const TYPES = [carType({ len: 4.3, cabLen: 2.3, cabH: 0.6, cabX: -0.2, taper: 0.72 }), carType({ len: 5.2, cabLen: 4.0, cabH: 0.95, cabX: -0.3, taper: 0.92 })];
  const bodyMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }));
  const typeOf = [];
  let carTypeMeshes = [];
  if (nCar > 0) {
    const r2 = mulberry32(seed + 7);
    for (let k = 0; k < nCar; k++) typeOf.push(r2() < 0.78 ? 0 : 1);
    carTypeMeshes = TYPES.map((t, ti) => {
      const n = typeOf.filter((v) => v === ti).length;
      const body = new THREE.InstancedMesh(t.body, bodyMat, Math.max(n, 1));
      const lamp = new THREE.InstancedMesh(t.lights, lightMat, Math.max(n, 1));
      body.count = lamp.count = n;
      body.frustumCulled = lamp.frustumCulled = false;
      group.add(body, lamp);
      cars.push(body, lamp);
      return { body, lamp, n };
    });
    const idx = [0, 0];
    const col = new THREE.Color();
    for (let k = 0; k < nCar; k++) {
      const road = plan.roads[Math.floor(r2() * plan.roads.length)];
      carState.push({ road, sign: r2() < 0.5 ? 1 : -1, t: r2() * road.len, speed: 7 + r2() * 7, lane: 4.2, type: typeOf[k], slot: idx[typeOf[k]]++ });
      carTypeMeshes[typeOf[k]].body.setColorAt(carState[k].slot, col.setHSL(r2(), 0.1 + r2() * 0.5, 0.25 + r2() * 0.4));
    }
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  function updateCars(dt) {
    if (!carState.length) return;
    for (let k = 0; k < carState.length; k++) {
      const c = carState[k];
      c.t = (c.t + c.speed * dt) % c.road.len;
      const along = c.sign * (c.t - c.road.len / 2);
      const side = c.sign * c.lane * (c.road.dir === 'x' ? 1 : -1);
      if (c.road.dir === 'x') {
        pos.set(c.road.x + along, 0.1, c.road.z + side);
        q.setFromAxisAngle(up, c.sign > 0 ? 0 : Math.PI);
      } else {
        pos.set(c.road.x + side, 0.1, c.road.z + along);
        q.setFromAxisAngle(up, c.sign > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      m4.compose(pos, q, one);
      carTypeMeshes[c.type].body.setMatrixAt(c.slot, m4);
      carTypeMeshes[c.type].lamp.setMatrixAt(c.slot, m4);
    }
    for (const t of carTypeMeshes) t.body.instanceMatrix.needsUpdate = t.lamp.instanceMatrix.needsUpdate = true;
  }
  updateCars(0);

  // 하늘 반사는 유리 외벽과 금속 외벽에만 준다. 바닥, 도로, 콘크리트, 벽돌은 반사하지 않아 보는 각도에 따라 색이 변하지 않는다.
  const ENV = { glass: 1.6, glass2: 1.6, metal: 0.5, metal2: 0.5 };
  const reflective = FACADES.filter((f) => ENV[f]).map((f) => ({ mat: mats[f], k: ENV[f] })); // scene.js가 반사 지도를 걸어 준다

  return {
    group,
    plan,
    reflective,
    // 낮이면 창이 어둡고 저녁이면 창과 가로등에 불이 켜지며, 먼 윤곽은 어두워진다
    setSky(name) {
      const dusk = name === 'dusk';
      for (const m of emissiveMats) m.emissiveIntensity = dusk ? 1.5 : 0.05;
      if (lampHeads) lampHeads.material.emissiveIntensity = dusk ? 2.5 : 0;
      skyline.material.color.setScalar(dusk ? 0.45 : 1);
      lightMat.color.setScalar(dusk ? 1.6 : 0.55); // 차량 앞뒤 등: 저녁에 밝아진다
    },
    carCount: () => carTypeMeshes.reduce((a, t) => a + t.body.count, 0), // 지금 그리는 차량 수(시험용)
    update(dt) {
      updateCars(Math.min(dt, 0.1));
    },
    // 런타임에 차량과 가로수 수를 줄인다(늘리지는 않는다)
    setCounts(nCars, nTrees) {
      if (carTypeMeshes.length) {
        const seen = [0, 0];
        for (let k = 0; k < Math.min(nCars, typeOf.length); k++) seen[typeOf[k]]++;
        carTypeMeshes.forEach((t, i) => (t.body.count = t.lamp.count = Math.min(t.n, seen[i])));
      }
      if (trees) for (const m of trees.children) m.count = Math.min(m.count, nTrees);
      if (lampHeads) lampHeads.count = lampPoles.count = Math.min(lampHeads.count, Math.floor(nTrees * 0.6));
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
