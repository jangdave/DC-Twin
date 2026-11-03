// 외관 단계의 배경: 하늘, 먼 언덕, 풀밭. 외부 이미지 없이 코드로 만든다(docs/22, docs/12 12.4장).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 하루 중 시간대. sun은 해의 방향(높이각 도, 방위각 도), 나머지는 색.
export const SKY_PRESETS = {
  day: { elev: 40, azim: 70, zenith: 0x2f6fc0, horizon: 0xbcd6ee, sun: 0xfff1d6, sunI: 3.0, hemiSky: 0xbfd8f5, hemiGround: 0x5a6a4a, hemiI: 1.4, fog: 0xbcd6ee, grass: 0x39502c },
  dusk: { elev: 9, azim: 130, zenith: 0x1f2f5c, horizon: 0xf0a070, sun: 0xffb27a, sunI: 3.2, hemiSky: 0x8f9fd0, hemiGround: 0x5a4a3a, hemiI: 1.5, fog: 0xc99a85, grass: 0x4a5a32 },
};

export function sunVector(elevDeg, azimDeg) {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azimDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
}

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // 항상 가장 먼 곳
}`;

const SKY_FRAG = `
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunColor; uniform vec3 sunDir; uniform vec3 groundColor; uniform float time;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(horizon, zenith, pow(h, 0.55));
  if (d.y < 0.0) col = mix(horizon, groundColor, smoothstep(0.0, -0.3, d.y)); // 지평선 아래는 땅 색(유리가 땅도 비추게)
  float s = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.28);
  if (d.y > 0.02) { // 구름: 하늘 위의 평면에 잡음 무늬를 얹는다
    vec2 uv = d.xz / (d.y + 0.18) * 1.1 + vec2(time * 0.004, 0.0);
    float c = smoothstep(0.52, 0.8, fbm(uv));
    c *= smoothstep(0.02, 0.2, d.y);
    vec3 cloud = mix(vec3(1.0), horizon * 0.9 + sunColor * 0.2, 0.25);
    col = mix(col, cloud, c * 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function makeSky() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      groundColor: { value: new THREE.Color(0x2a3326) },
      time: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// 먼 언덕: 링 모양 땅을 잡음으로 올려 지평선에 윤곽을 만든다. 풀밭 색과 안개에 섞인다.
export function makeHills(color, inner = 260, outer = 700, amp = 14) {
  const geo = new THREE.RingGeometry(inner, outer, 96, 8);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    const a = Math.atan2(z, x);
    const t = (r - inner) / (outer - inner);
    const h = (Math.sin(a * 3.0) * 0.5 + Math.sin(a * 7.0 + 1.3) * 0.3 + Math.sin(a * 13.0 + 0.4) * 0.2 + 1.0) * amp * Math.sin(Math.min(t * 1.6, 1) * Math.PI * 0.5);
    p.setY(i, h);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.position.y = -0.3;
  m.receiveShadow = false;
  return m;
}

// glb 안의 메시를 재질별로 합친다. 좌표는 cm에서 m로 줄인다.
export function mergeByMaterial(root, scale) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  const bake = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh) return;
    bake.makeScale(scale, scale, scale).multiply(o.matrixWorld);
    let g = o.geometry.clone().applyMatrix4(bake);
    const mt = Array.isArray(o.material) ? o.material[0] : o.material;
    for (const a of mt.map ? ['uv1', 'uv2', 'color', 'tangent'] : ['uv', 'uv1', 'uv2', 'color', 'tangent']) g.deleteAttribute(a); // 기본색 그림이 있는 재질만 uv를 둔다
    g = g.index ? g.toNonIndexed() : g;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(g);
  });
  const meshes = [];
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const mesh = new THREE.Mesh(merged, mat);
    if (mat.map) mat.map.anisotropy = 8;
    if (mat.opacity < 1) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
    mesh.castShadow = mat.opacity >= 1;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  return meshes;
}
