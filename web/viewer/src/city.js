// 데이터센터 주변 도심 (docs/23). 외부 에셋 없이 상자 건물, 도로, 가로수, 차량을 코드로 만든다. 가상의 도시이며 실제 지역이 아니다.
//   planCity: 배치만 계산(순수 함수, 시험 가능). buildCity: three.js 객체를 만든다.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const CITY = {
  pitchX: 210, // 블록 중심 간격(m). 가운데 블록에 데이터센터 부지(약 130 x 105 m)가 들어간다
  pitchZ: 185,
  road: 20, // 도로 폭
  setback: 4,
};

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 블록마다 2x2 필지로 나누고 필지마다 건물 높이를 정한다. 가운데 블록(0,0)은 비운다.
export function planCity({ cx, cz, rings, seed = 11 }) {
  const rng = mulberry32(seed);
  const bw = CITY.pitchX - CITY.road;
  const bd = CITY.pitchZ - CITY.road;
  const blocks = [];
  const buildings = [];
  for (let i = -rings; i <= rings; i++) {
    for (let j = -rings; j <= rings; j++) {
      if (i === 0 && j === 0) continue;
      const ring = Math.max(Math.abs(i), Math.abs(j));
      const bx = cx + i * CITY.pitchX;
      const bz = cz + j * CITY.pitchZ;
      blocks.push({ i, j, ring, x: bx, z: bz, w: bw, d: bd });
      const sx = 0.35 + rng() * 0.3; // 필지를 나누는 위치
      const sz = 0.35 + rng() * 0.3;
      const xs = [bw * sx, bw * (1 - sx)];
      const zs = [bd * sz, bd * (1 - sz)];
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          if (rng() < 0.12) continue; // 빈 터
          const w = xs[a] - CITY.setback * 2;
          const d = zs[b] - CITY.setback * 2;
          const px = bx - bw / 2 + (a === 0 ? xs[0] / 2 : xs[0] + xs[1] / 2);
          const pz = bz - bd / 2 + (b === 0 ? zs[0] / 2 : zs[0] + zs[1] / 2);
          const lo = [0, 10, 26, 45][Math.min(ring, 3)]; // 가까운 블록은 낮게(데이터센터가 가려지지 않게)
          const hi = [0, 26, 62, 150][Math.min(ring, 3)];
          buildings.push({ x: px, z: pz, w, d, h: lo + rng() * (hi - lo), tint: rng(), ring, uvSeed: rng() });
        }
      }
    }
  }
  // 도로 띠: 블록 사이. 동서 방향(z 고정)과 남북 방향(x 고정)
  const roads = [];
  const lenX = (2 * rings + 2) * CITY.pitchX;
  const lenZ = (2 * rings + 2) * CITY.pitchZ;
  for (let j = -rings - 1; j <= rings; j++) roads.push({ dir: 'x', x: cx, z: cz + (j + 0.5) * CITY.pitchZ, len: lenX });
  for (let i = -rings - 1; i <= rings; i++) roads.push({ dir: 'z', x: cx + (i + 0.5) * CITY.pitchX, z: cz, len: lenZ });
  // 가로수 자리: 블록 가장자리(인도 위)를 따라 16 m 간격
  const trees = [];
  for (const b of blocks) {
    const m = 3;
    for (let t = -b.w / 2 + 8; t < b.w / 2; t += 16) {
      trees.push([b.x + t, b.z - b.d / 2 + m], [b.x + t, b.z + b.d / 2 - m]);
    }
    for (let t = -b.d / 2 + 8; t < b.d / 2; t += 16) {
      trees.push([b.x - b.w / 2 + m, b.z + t], [b.x + b.w / 2 - m, b.z + t]);
    }
  }
  return { blocks, buildings, roads, trees };
}

// ---- 그림(캔버스) ----
function windowTextures() {
  const S = 128; // 4 x 4 창
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    return c;
  };
  const wall = mk(), glow = mk();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#8c9199';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const rng = mulberry32(5);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 32 + 4, y = r * 32 + 6;
      const lit = rng() < 0.38;
      a.fillStyle = lit ? '#cdb98a' : '#27384a';
      a.fillRect(x, y, 24, 20);
      if (lit) {
        g.fillStyle = '#ffd08a';
        g.fillRect(x, y, 24, 20);
      }
    }
  }
  const tw = new THREE.CanvasTexture(wall), te = new THREE.CanvasTexture(glow);
  for (const t of [tw, te]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  tw.colorSpace = THREE.SRGBColorSpace;
  te.colorSpace = THREE.SRGBColorSpace;
  return { wall: tw, glow: te };
}

function roadTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#3b3d41';
  x.fillRect(0, 0, 64, 128);
  const rng = mulberry32(9);
  for (let i = 0; i < 700; i++) {
    const v = 50 + Math.floor(rng() * 30);
    x.fillStyle = `rgb(${v},${v},${v + 3})`;
    x.fillRect(rng() * 64, rng() * 128, 1.5, 1.5);
  }
  x.fillStyle = '#d9c25a'; // 가운데 노란 점선
  x.fillRect(30, 8, 4, 48);
  x.fillStyle = '#c9ccd0'; // 양쪽 가장자리 선
  x.fillRect(3, 0, 2, 128);
  x.fillRect(59, 0, 2, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 상자 한 동: 창 무늬가 건물 크기에 맞게 반복되도록 uv를 키우고 색을 입힌다.
function buildingGeometry(b) {
  const g = new THREE.BoxGeometry(b.w, b.h, b.d);
  g.translate(b.x, 0.25 + b.h / 2, b.z);
  const uv = g.attributes.uv;
  const FW = 12.8, FH = 14.4; // 그림 한 장이 덮는 가로, 세로(m)
  const ou = Math.floor(b.uvSeed * 4) / 4, ov = Math.floor((b.uvSeed * 16) % 4) / 4;
  const faces = [
    [b.d / FW, b.h / FH], [b.d / FW, b.h / FH], // +x, -x
    null, null, // +y(지붕), -y
    [b.w / FW, b.h / FH], [b.w / FW, b.h / FH], // +z, -z
  ];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const n = f * 4 + k;
      if (!faces[f]) {
        uv.setXY(n, 0.02, 0.02); // 창 없는 쪽(지붕): 벽색 한 점
      } else {
        const [su, sv] = faces[f];
        uv.setXY(n, Math.round(uv.getX(n) * su * 4) / 4 + ou, uv.getY(n) * sv + ov);
      }
    }
  }
  const col = new Float32Array(g.attributes.position.count * 3);
  const t = 0.42 + 0.36 * b.tint;
  const warm = b.tint > 0.6 ? [1.0, 0.96, 0.9] : [0.92, 0.96, 1.0];
  for (let n = 0; n < g.attributes.position.count; n++) {
    col[n * 3] = t * warm[0];
    col[n * 3 + 1] = t * warm[1];
    col[n * 3 + 2] = t * warm[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function buildCity({ cx, cz, quality, seed = 11 }) {
  const plan = planCity({ cx, cz, rings: quality.cityRings, seed });
  const group = new THREE.Group();
  const disposables = [];
  const track = (o) => (disposables.push(o), o);

  // 건물(한 번에 그림)
  const tex = windowTextures();
  track(tex.wall);
  track(tex.glow);
  const bMat = track(new THREE.MeshStandardMaterial({ map: tex.wall, emissiveMap: tex.glow, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.05, vertexColors: true, roughness: 0.65, metalness: 0.15 }));
  const bGeo = track(mergeGeometries(plan.buildings.map(buildingGeometry), false));
  const buildings = new THREE.Mesh(bGeo, bMat);
  group.add(buildings);

  // 인도 판(블록마다) 합치기
  const slabs = plan.blocks.map((b) => new THREE.BoxGeometry(b.w, 0.25, b.d).translate(b.x, 0.125, b.z));
  const slabGeo = track(mergeGeometries(slabs, false));
  const slabMat = track(new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.95 }));
  group.add(new THREE.Mesh(slabGeo, slabMat));

  // 도로
  const rt = track(roadTexture());
  const roadMat = track(new THREE.MeshStandardMaterial({ map: rt, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const strips = plan.roads.map((r, n) => {
    const g = new THREE.PlaneGeometry(CITY.road, r.len);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * (r.len / 16));
    if (r.dir === 'x') g.rotateY(Math.PI / 2);
    g.translate(r.x, 0.02 + (r.dir === 'x' ? 0.01 : 0) + n * 0.0005, r.z);
    return g;
  });
  group.add(new THREE.Mesh(track(mergeGeometries(strips, false)), roadMat));

  // 가로수(인스턴스)
  const nTree = Math.min(quality.trees, plan.trees.length);
  let trees = null;
  if (nTree > 0) {
    const rng = mulberry32(seed + 3);
    const pick = plan.trees.slice().sort(() => rng() - 0.5).slice(0, nTree);
    const trunkG = track(new THREE.CylinderGeometry(0.22, 0.3, 3, 6).translate(0, 1.5, 0));
    const crownG = track(new THREE.IcosahedronGeometry(2.3, 0).translate(0, 4.6, 0));
    const trunkM = track(new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }));
    const crownM = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
    const trunk = new THREE.InstancedMesh(trunkG, trunkM, nTree);
    const crown = new THREE.InstancedMesh(crownG, crownM, nTree);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    pick.forEach(([x, z], k) => {
      const s = 0.8 + rng() * 0.6;
      m4.compose(new THREE.Vector3(x, 0.25, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
      trunk.setMatrixAt(k, m4);
      crown.setMatrixAt(k, m4);
      crown.setColorAt(k, col.setHSL(0.27 + rng() * 0.05, 0.45, 0.2 + rng() * 0.1));
    });
    trees = new THREE.Group();
    trees.add(trunk, crown);
    group.add(trees);
  }

  // 차량(인스턴스, 도로를 따라 움직임)
  let cars = null;
  const nCar = quality.cars;
  const carState = [];
  if (nCar > 0) {
    const rng = mulberry32(seed + 7);
    const carG = track(new THREE.BoxGeometry(4.2, 1.4, 1.9).translate(0, 0.9, 0));
    const carM = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.5 }));
    cars = new THREE.InstancedMesh(carG, carM, nCar);
    const col = new THREE.Color();
    for (let k = 0; k < nCar; k++) {
      const road = plan.roads[Math.floor(rng() * plan.roads.length)];
      const dirSign = rng() < 0.5 ? 1 : -1; // 차선: 진행 방향의 오른쪽
      carState.push({ road, sign: dirSign, t: rng() * road.len, speed: 7 + rng() * 7, lane: 4.2 });
      cars.setColorAt(k, col.setHSL(rng(), 0.1 + rng() * 0.5, 0.25 + rng() * 0.4));
    }
    cars.frustumCulled = false;
    group.add(cars);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  function updateCars(dt) {
    if (!cars) return;
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
      cars.setMatrixAt(k, m4);
    }
    cars.instanceMatrix.needsUpdate = true;
  }
  updateCars(0);

  return {
    group,
    plan,
    // 낮이면 창이 어둡고 저녁이면 불이 켜진다
    setSky(name) {
      bMat.emissiveIntensity = name === 'dusk' ? 1.5 : 0.05;
    },
    update(dt) {
      updateCars(Math.min(dt, 0.1));
    },
    // 런타임에 차량과 가로수 수를 줄인다(늘리지는 않는다)
    setCounts(nCars, nTrees) {
      if (cars) cars.count = Math.min(cars.count, nCars);
      if (trees) for (const m of trees.children) m.count = Math.min(m.count, nTrees);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const o of [trees, cars]) o?.traverse?.((x) => x.dispose?.());
    },
  };
}
