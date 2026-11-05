// 데이터센터 부지의 나무(주차장 앞 줄)용 상세 나무. 외부 에셋 없이 코드로 만든다.
// 줄기는 아래가 굵고 가지 3개가 수관 안으로 뻗고, 수관은 9개 덩어리(구를 구름처럼 찌그러뜨림)를 반구 모양으로 모은다.
// 꼭짓점 색: 덩어리 아래쪽은 어둡고 위쪽은 밝으며 덩어리마다 색조가 조금씩 다르다(한 덩어리 초록으로 보이지 않게).
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './citytex.js';

function paint(g, fn) {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const [r, gg, b] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// 반환: { trunk, crown } (두 지오메트리 모두 꼭짓점 색 있음, 높이 약 7 m, 바닥이 y=0)
export function siteTreeGeometries(seed = 17) {
  const rng = mulberry32(seed);
  // 줄기와 가지
  const parts = [new THREE.CylinderGeometry(0.17, 0.36, 3.6, 10, 3).translate(0, 1.8, 0)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng();
    const br = new THREE.CylinderGeometry(0.05, 0.11, 2.2, 6).translate(0, 1.1, 0);
    br.rotateZ(0.7).rotateY(a).translate(0, 2.7, 0);
    parts.push(br);
  }
  const trunk = paint(mergeGeometries(parts.map((p) => p.toNonIndexed())), (x, y) => {
    const k = 0.7 + 0.3 * Math.min(y / 4, 1);
    return [0.3 * k, 0.21 * k, 0.14 * k];
  });
  // 수관: 구름 모양 덩어리 9개
  const centers = [[0, 5.0, 0, 1.7], [1.3, 4.4, 0.6, 1.4], [-1.2, 4.5, -0.7, 1.45], [0.4, 4.2, -1.5, 1.25], [-0.6, 4.3, 1.4, 1.3], [0.2, 6.2, 0.1, 1.3], [1.4, 5.6, -0.6, 1.1], [-1.4, 5.7, 0.5, 1.1], [0, 3.9, 0, 1.2]];
  const lumps = centers.map(([cx, cy, cz, r], idx) => {
    const g = mergeVertices(new THREE.IcosahedronGeometry(r, 2));
    const p = g.attributes.position;
    const n = (x, y, z) => { // 같은 위치는 같은 값을 주는 간단한 잡음
      const s = Math.sin(x * 3.1 + idx) * Math.cos(y * 2.7 - idx) + Math.sin(z * 3.7 + x * 1.3);
      return 0.86 + 0.14 * (s * 0.5 + 0.5) + 0.06 * Math.sin((x + y + z) * 6 + idx * 2);
    };
    for (let i = 0; i < p.count; i++) {
      const f = n(p.getX(i), p.getY(i), p.getZ(i));
      p.setXYZ(i, p.getX(i) * f * 1.05, p.getY(i) * f * 0.88, p.getZ(i) * f * 1.05);
    }
    g.computeVertexNormals();
    g.translate(cx, cy, cz);
    const hue = 0.24 + 0.07 * rng(), lum = 0.9 + 0.2 * rng();
    const base = new THREE.Color().setHSL(hue, 0.5, 0.115 * lum);
    const top = new THREE.Color().setHSL(hue - 0.01, 0.55, 0.23 * lum);
    paint(g, (x, y) => {
      const t = Math.min(Math.max((y - (cy - r)) / (2 * r * 0.88), 0), 1); // 덩어리 안에서 높이
      const c = base.clone().lerp(top, Math.pow(t, 0.8));
      return [c.r, c.g, c.b];
    });
    return g.toNonIndexed();
  });
  const crown = mergeGeometries(lumps);
  return { trunk, crown };
}

// 줄기 지오메트리(삼각형이 따로 떨어진 형태)에서 나무 위치를 군집으로 찾는다. 반환: [{ x, z, y0 }]
export function trunkCenters(geometry, radius = 1.5) {
  const p = geometry.attributes.position;
  const cl = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
    const f = cl.find((c) => Math.hypot(c.x - x, c.z - z) < radius);
    if (!f) cl.push({ x, z, n: 1, y0: y });
    else {
      f.x = (f.x * f.n + x) / (f.n + 1);
      f.z = (f.z * f.n + z) / (f.n + 1);
      f.n++;
      f.y0 = Math.min(f.y0, y);
    }
  }
  return cl.map(({ x, z, y0 }) => ({ x, z, y0 }));
}

// 삼각형 단위로 지우고 남긴다(색인이 없는 지오메트리). keep(cx, cy, cz)가 참인 삼각형만 남긴다.
export function filterTriangles(geometry, keep) {
  const p = geometry.attributes.position;
  const tri = [];
  for (let t = 0; t < p.count / 3; t++) {
    const i = t * 3;
    const cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    if (keep(cx, cy, cz)) tri.push(t);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize;
    const arr = new attr.array.constructor(tri.length * 3 * size);
    tri.forEach((t, k) => {
      for (let v = 0; v < 3; v++) for (let c = 0; c < size; c++) arr[(k * 3 + v) * size + c] = attr.array[(t * 3 + v) * size + c];
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
