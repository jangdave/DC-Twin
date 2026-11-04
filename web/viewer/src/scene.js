// Three.js 장면 (docs/18 5.1, 5.3장). 랙은 InstancedMesh 묶음으로 그리고 값은 인스턴스 색으로 칠한다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SKY_PRESETS, makeHills, makeSky, mergeByMaterial, sunVector } from './env.js';
import { Airflow, loadFlow } from './airflow.js';
import { buildCity } from './city.js';
import { prepareShell, shellVisibility } from './hall_shell.js';
import { CCTV_LIMITS } from './cctv.js';
import { VIEWS } from './views.js';
import { SETTINGS } from './quality.js';
import { ALARM_COLOR, barFraction, confidenceColor, sampleColor } from './colors.js';

const CM = 0.01;

// 반사하지 않는 면을 보는 각도와 무관한 재질(Lambert, 빛과 면의 방향만 쓴다)로 바꾼다. 색, 그림, 법선 지도, 투명도는 그대로 옮긴다.
export function toLambert(src) {
  const m = new THREE.MeshLambertMaterial({
    name: src.name, color: src.color?.clone() ?? new THREE.Color(0xffffff), map: src.map ?? null, normalMap: src.normalMap ?? null,
    transparent: src.transparent, opacity: src.opacity, side: src.side, alphaTest: src.alphaTest,
    polygonOffset: src.polygonOffset, polygonOffsetFactor: src.polygonOffsetFactor, polygonOffsetUnits: src.polygonOffsetUnits,
  });
  if (src.normalScale) m.normalScale.copy(src.normalScale);
  src.dispose();
  return m;
}

// 재질별 하늘 반사 세기. 유리와 금속만 반사하고 바닥, 콘크리트, 지붕, 잔디는 반사하지 않는다.
// (거친 바닥이 반사를 받으면 낮은 각도에서 하늘색이 섞여 보는 각도에 따라 바닥 색이 달라 보인다.)
export function envIntensityFor(name = '') {
  if (/Glass/i.test(name)) return 2.2; // 정면은 어둡고 비스듬히 볼수록 하늘이 많이 비치는 유리
  if (/PanelMetal/i.test(name)) return 0.5;
  if (/Fan/i.test(name)) return 0.35;
  if (/Mullion|Louver|OutdoorEquip/i.test(name)) return 0.25;
  return 0;
}

// 부드러운 원형 빛 번짐 그림(표시등용)
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
// 장면 좌표(cm, Z가 위) -> three.js 좌표(m, Y가 위). 손 방향이 바뀌지 않게 y는 부호를 뒤집는다.
const toThree = (x, y, z) => new THREE.Vector3(x * CM, z * CM, -y * CM);
const keyOf = (name) => name.toLowerCase(); // Rack_01 -> rack_01

const BODY = new THREE.Color(0x2b313b);
const CRAC_BODY = new THREE.Color(0x30404f);
const CRAC_OK = [0.08, 0.4, 0.55];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class HallScene {
  constructor(canvas, labelLayer, data, store, { reducedMotion = false, stage = 'hall', tier = 'high' } = {}) {
    this.tier = tier;
    this.q = { ...SETTINGS[tier] };
    this.store = store;
    this.data = data;
    this.reducedMotion = reducedMotion;
    this.view = 'temp_in';
    this._lastVersion = -1;
    this._dirty = true;
    this.selected = null;
    this.hovered = null;
    this.labelLayer = labelLayer;
    this.labels = [];
    this.showLabels = false;
    this._anim = null;
    this.stage = stage;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // 해와 건물이 움직이지 않으니 그림자 지도는 필요할 때만 다시 그린다
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1218);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2500);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !reducedMotion;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 45;

    const [sx, sy, sz] = data.size;
    this.center = toThree(sx / 2, sy / 2, 0);
    this.hallLights = new THREE.Group(); // 홀 조명. 외관 단계에서는 끈다
    this.hallLights.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 14, 8);
    this.hallLights.add(sun);
    this.scene.add(this.hallLights);

    this.hall = new THREE.Group();
    this.scene.add(this.hall);
    this._buildStatic(data, sx, sy, sz);
    this._buildRacks(data);
    this._buildCracs(data);
    this.setHeat(false);
    this._buildSelection();
    this._buildLabels(data);
    this._buildExterior(data, sx, sy, sz);
    this.setStage(stage, true);
  }

  // ---- 만들기 ----
  _buildStatic(data, sx, sy, sz) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(sx * CM, sy * CM), new THREE.MeshStandardMaterial({ color: 0x1d222b, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(this.center);
    floor.position.y = -0.01;
    this.hall.add(floor);
    this._plainHall = [floor];
    const grid = new THREE.GridHelper(Math.max(sx, sy) * CM, Math.round(Math.max(sx, sy) / 100), 0x2c333f, 0x232933);
    grid.position.copy(this.center);
    this.hall.add(grid);
    this._plainHall.push(grid);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx * CM, sz * CM, sy * CM)), new THREE.LineBasicMaterial({ color: 0x3a4352 }));
    outline.position.set(this.center.x, (sz * CM) / 2, this.center.z);
    this.hall.add(outline);
    this._plainHall.push(outline);

    const boxMesh = (items, material) => {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
      items.forEach((b, i) => mesh.setMatrixAt(i, this._boxMatrix(b)));
      this.hall.add(mesh);
      return mesh;
    };
    boxMesh(data.vents, new THREE.MeshBasicMaterial({ color: 0x1b5fb0 }));
    const panels = boxMesh(data.panels, new THREE.MeshStandardMaterial({ color: 0x5a9bd8, transparent: true, opacity: 0.1, depthWrite: false }));
    panels.renderOrder = 2;
  }

  _boxMatrix(b, grow = 0) {
    const min = toThree(b.min[0], b.min[1], b.min[2]);
    const max = toThree(b.max[0], b.max[1], b.max[2]);
    const size = new THREE.Vector3(Math.abs(max.x - min.x) + grow, Math.abs(max.y - min.y) + grow, Math.abs(max.z - min.z) + grow);
    const c = min.clone().add(max).multiplyScalar(0.5);
    return new THREE.Matrix4().compose(c, new THREE.Quaternion(), size);
  }

  // 앞면 판: 앞면(front 축, 방향) 바깥에 얇게 붙인다. 센서(입구 온도)가 앞면에 있어서 앞면을 값으로 칠한다.
  _frontMatrix(b, inset = 0.04, thick = 0.02) {
    const [axis, sign] = b.front;
    const w = (b.max[0] - b.min[0]) * CM;
    const d = (b.max[1] - b.min[1]) * CM;
    const h = (b.max[2] - b.min[2]) * CM;
    const c = toThree((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const size = new THREE.Vector3();
    if (axis === 0) {
      // 앞면이 x 방향: 판은 y(three z) 폭을 가진다
      size.set(thick, h - inset, d - inset);
      c.x += sign * (w / 2 + thick / 2);
    } else {
      size.set(w - inset, h - inset, thick);
      c.z += -sign * (d / 2 + thick / 2);
    }
    return new THREE.Matrix4().compose(c, new THREE.Quaternion(), size);
  }

  // 윗면 덮개: 위나 비스듬한 각도에서도 값 색이 보이게 랙 윗면도 같은 색으로 칠한다
  _topMatrix(b, inset = 0.04, thick = 0.02) {
    const w = (b.max[0] - b.min[0]) * CM;
    const d = (b.max[1] - b.min[1]) * CM;
    const c = toThree((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]);
    c.y += thick / 2;
    return new THREE.Matrix4().compose(c, new THREE.Quaternion(), new THREE.Vector3(w - inset, thick, d - inset));
  }

  _buildRacks(data) {
    const n = data.racks.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.rackBody = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.6, metalness: 0.2 }), n);
    this.rackFront = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.rackTop = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.rackHull = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide }), n);
    this.barTrack = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x3a4250 }), n);
    this.bar = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.rackKeys = [];
    this._rackCenter = [];
    data.racks.forEach((r, i) => {
      this.rackBody.setMatrixAt(i, this._boxMatrix(r));
      this.rackFront.setMatrixAt(i, this._frontMatrix(r));
      this.rackTop.setMatrixAt(i, this._topMatrix(r));
      this.rackTop.setColorAt(i, new THREE.Color(0.25, 0.25, 0.25));
      this.rackHull.setMatrixAt(i, ZERO);
      this.rackHull.setColorAt(i, new THREE.Color(1, 1, 1));
      this.rackFront.setColorAt(i, new THREE.Color(0.25, 0.25, 0.25));
      this.bar.setColorAt(i, new THREE.Color(1, 1, 1));
      this.barTrack.setMatrixAt(i, ZERO);
      this.bar.setMatrixAt(i, ZERO);
      this.rackKeys.push(keyOf(r.name));
      const c = toThree((r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2, (r.max[2]) / 1);
      this._rackCenter.push(c);
    });
    for (const m of [this.rackBody, this.rackFront, this.rackTop, this.rackHull, this.barTrack, this.bar]) {
      m.frustumCulled = false;
      this.hall.add(m);
    }
    this.rackHull.renderOrder = 1;
    this._tmp = new THREE.Matrix4();
  }

  _buildCracs(data) {
    const n = data.cracs.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.cracBody = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: CRAC_BODY, roughness: 0.55, metalness: 0.3 }), n);
    this.cracFront = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.cracKeys = [];
    data.cracs.forEach((c, i) => {
      this.cracBody.setMatrixAt(i, this._boxMatrix(c));
      this.cracFront.setMatrixAt(i, this._frontMatrix(c, 0.1, 0.03));
      this.cracFront.setColorAt(i, new THREE.Color(...CRAC_OK));
      this.cracKeys.push(keyOf(c.name));
    });
    for (const m of [this.cracBody, this.cracFront]) {
      m.frustumCulled = false;
      this.hall.add(m);
    }
  }

  // ---- 공기 흐름 입자(docs/22) ----
  async loadAirflow(baseUrl) {
    const flow = await loadFlow(baseUrl);
    this.airflow = new Airflow(flow, this.data, this.store, this.rackKeys, this.cracKeys, { count: this.q.particles });
    this.airflow.points.visible = this.showAirflow ?? false; // 서버실 기본 보기에서는 끈다(시뮬레이션 메뉴에서 켠다)
    this.hall.add(this.airflow.points);
    return this.airflow.count;
  }

  // 온도 색칠(랙 앞면과 윗면의 값 색, 신뢰 막대)을 켜고 끈다. 끄면 장비 원래 모습만 보인다. 알람 테두리는 항상 보인다.
  setHeat(on) {
    this.heat = on;
    for (const m of [this.rackFront, this.rackTop, this.cracFront, this.barTrack, this.bar]) m.visible = on;
    this._dirty = true;
  }

  setAirflow(on) {
    this.showAirflow = on;
    if (this.airflow) this.airflow.points.visible = on;
    this._dirty = true;
  }

  _stepAirflow(dtSec, timeSec) {
    const a = this.airflow;
    if (!a || !a.points.visible || this.stage !== 'hall') return;
    if (this.store.version !== this._flowVersion) {
      this._flowVersion = this.store.version;
      a.setFans(this.cracKeys.map((k) => {
        const v = this.store.metric(k, 'fan_speed')?.value;
        return v == null ? 1 : v / 100;
      }));
    }
    a.step(dtSec, timeSec);
  }

  // ---- 가상 CCTV: 한 화면(캔버스)을 칸으로 나눠 같은 장면을 여러 카메라로 그린다 ----
  // tiles: [{ el, def }]  el은 칸의 DOM 요소(위치와 크기를 매 프레임 읽어 그릴 영역으로 쓴다), def는 buildCameras 항목.
  setCctv(tiles) {
    if (!tiles) {
      this.cctv = null;
      for (const l of this.labels) l.el.hidden = !this.showLabels;
      this._dirty = true;
      return;
    }
    const lim = CCTV_LIMITS[this.tier] ?? CCTV_LIMITS.mid;
    this.cctv = {
      fps: lim.fps,
      last: -1,
      tiles: tiles.map(({ el, def }) => {
        const cam = new THREE.PerspectiveCamera(def.fov, 16 / 9, 0.1, 120);
        cam.position.copy(toThree(...def.pos));
        cam.lookAt(toThree(...def.target));
        return { el, cam, def };
      }),
    };
    for (const l of this.labels) l.el.hidden = true;
  }

  _renderCctv(timeSec) {
    const c = this.cctv;
    if (c.last >= 0 && timeSec - c.last < 1 / c.fps) return;
    c.last = timeSec;
    const r = this.renderer;
    const cv = r.domElement;
    const cr = cv.getBoundingClientRect();
    const hiddenHelpers = [this.selBox, this.hoverBox].map((o) => [o, o.visible]);
    for (const [o] of hiddenHelpers) o.visible = false;
    r.setScissorTest(false);
    r.setViewport(0, 0, cr.width, cr.height);
    r.setClearColor(0x0a0d12, 1);
    r.clear();
    r.setScissorTest(true);
    for (const t of c.tiles) {
      const b = t.el.getBoundingClientRect();
      const w = Math.floor(b.width);
      const h = Math.floor(b.height);
      if (w < 8 || h < 8) continue;
      const x = Math.floor(b.left - cr.left);
      const y = Math.floor(cr.height - (b.bottom - cr.top));
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      if (Math.abs(t.cam.aspect - w / h) > 0.01) {
        t.cam.aspect = w / h;
        t.cam.updateProjectionMatrix();
      }
      if (this.shell) {
        const v = shellVisibility(t.cam.position, this._shellBounds);
        for (const [name, vis] of Object.entries(v)) {
          const o = this.shellParts.get(name);
          if (o) o.visible = vis;
        }
      }
      r.render(this.scene, t.cam);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, cr.width, cr.height);
    for (const [o, vis] of hiddenHelpers) o.visible = vis;
  }

  // ---- 서버실 껍데기(바닥, 벽, 천장, 조명) ----
  // 장면 USD의 Shell을 내보낸 glb(웹 좌표, m). 받으면 옛 어두운 바닥, 격자, 점선 상자는 숨긴다.
  async loadHallShell(baseUrl) {
    const gltf = await new GLTFLoader().loadAsync(`${baseUrl}models/hall_shell.glb`);
    this.shellParts = prepareShell(gltf.scene);
    this.shell = gltf.scene;
    this.hall.add(this.shell);
    for (const o of this._plainHall ?? []) o.visible = false;
    const [sx, sy, sz] = this.data.size;
    this._shellBounds = { minX: 0, maxX: sx * CM, minZ: -sy * CM, maxZ: 0, height: sz * CM };
    this._dirty = true;
    return this.shellParts.size;
  }

  _updateShell() {
    if (!this.shell) return;
    const v = shellVisibility(this.camera.position, this._shellBounds);
    let changed = false;
    for (const [name, vis] of Object.entries(v)) {
      const o = this.shellParts.get(name);
      if (o && o.visible !== vis) { o.visible = vis; changed = true; }
    }
    if (changed) this._dirty = true;
  }

  // ---- 장비 모양(glb) ----
  // 모델(cm 단위, 정면 +Z, 바닥 중앙이 원점)을 재질별로 합쳐 인스턴스로 그린다. 값 색 판(rackFront 등)은 반투명으로 겹친다.
  async loadModels(baseUrl) {
    const loader = new GLTFLoader();
    const [rack, crac] = await Promise.all([loader.loadAsync(`${baseUrl}models/rack.glb`), loader.loadAsync(`${baseUrl}models/crac.glb`)]);
    this.modelMeshes = [...this._instanceModel(rack.scene, this.data.racks), ...this._instanceModel(crac.scene, this.data.cracs)];
    for (const m of this.modelMeshes) this.hall.add(m);
    this.modelsReady = true;
    this.setModels(this.useModels ?? true);
    return this.modelMeshes.length;
  }

  _instanceModel(root, boxes) {
    root.updateMatrixWorld(true);
    const byMaterial = new Map();
    const bake = new THREE.Matrix4();
    root.traverse((o) => {
      if (!o.isMesh) return;
      bake.makeScale(CM, CM, CM).multiply(o.matrixWorld); // cm -> m
      let g = o.geometry.clone().applyMatrix4(bake);
      for (const a of ['uv', 'uv1', 'uv2', 'color', 'tangent']) g.deleteAttribute(a);
      g = g.index ? g.toNonIndexed() : g;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!byMaterial.has(mat)) byMaterial.set(mat, []);
      byMaterial.get(mat).push(g);
    });
    const meshes = [];
    const m4 = new THREE.Matrix4();
    for (const [mat, geos] of byMaterial) {
      const merged = mergeGeometries(geos, false);
      merged.computeBoundingSphere();
      const im = new THREE.InstancedMesh(merged, mat, boxes.length);
      boxes.forEach((b, i) => {
        const [axis, sign] = b.front;
        const fx = axis === 0 ? sign : 0;
        const fy = axis === 1 ? sign : 0;
        const yaw = Math.atan2(fx, -fy); // 모델 정면(+Z)을 상자의 앞면 방향으로 돌린다
        const c = toThree((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]);
        m4.compose(c, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
        im.setMatrixAt(i, m4);
      });
      im.frustumCulled = false;
      meshes.push(im);
    }
    return meshes;
  }

  // 장비 모양(true)과 단순 상자(false)를 바꾼다. 모델이 아직 없으면 상자로 둔다.
  setModels(on) {
    this.useModels = on;
    const show = on && this.modelsReady;
    for (const m of this.modelMeshes ?? []) m.visible = show;
    this.rackBody.visible = !show; // 숨겨도 선택(레이캐스트)에는 계속 쓴다
    this.cracBody.visible = !show;
    for (const mesh of [this.rackFront, this.rackTop, this.cracFront]) {
      mesh.material.transparent = show;
      mesh.material.opacity = show ? 0.5 : 1;
      mesh.material.depthWrite = !show;
      mesh.material.needsUpdate = true;
    }
    this._dirty = true;
  }

  _buildSelection() {
    this.selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x4fd8ff }));
    this.selBox.visible = false;
    this.selBox.renderOrder = 3;
    this.hall.add(this.selBox);
    this.hoverBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    this.hoverBox.visible = false;
    this.hall.add(this.hoverBox);
  }

  // 외관: 새 에셋 없이 홀 치수에서 계산한 단순 상자 건물(docs/20 4.2장). 실제 시설 형상이 아니다.
  _buildExterior(data, sx, sy, sz) {
    const g = new THREE.Group();
    const W = (sx + 1000) * CM;
    const D = (sy + 1000) * CM;
    const H = sz * CM + 1.6;
    const c = this.center;
    const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
    const add = (w, h, d, x, y, z, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      g.add(mesh);
      return mesh;
    };
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1100, 64), new THREE.MeshLambertMaterial({ color: 0x39502c, depthWrite: false }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(c.x, -0.35, c.z);
    ground.receiveShadow = true;
    ground.renderOrder = -10; // 가장 먼저 그리고 깊이를 쓰지 않아, 깊이 정밀도가 모자란 기기에서도 아스팔트와 다투지 않는다
    g.add(ground);
    this.ground = ground;
    this.sky = makeSky();
    this.sky.position.copy(c);
    g.add(this.sky);
    this.hills = makeHills(0x39502c, 1100, 2000, 60);
    this.hills.material.depthWrite = false;
    this.hills.renderOrder = -9;
    this.hills.position.set(c.x, -0.3, c.z);
    g.add(this.hills);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    g.add(this.hemi);
    this.sunExt = new THREE.DirectionalLight(0xffffff, 2);
    this.sunExt.castShadow = this.q.shadow > 0;
    this.sunExt.shadow.mapSize.set(this.q.shadow || 1, this.q.shadow || 1);
    const sc = this.sunExt.shadow.camera;
    Object.assign(sc, { left: -110, right: 110, top: 110, bottom: -110, near: 10, far: 500 });
    this.sunExt.shadow.bias = -0.0004;
    this.sunExt.shadow.normalBias = 0.3;
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.position.copy(c);
    g.add(this.sunTarget);
    this.sunExt.target = this.sunTarget;
    g.add(this.sunExt);
    this.building = [];
    this.building.push(add(W, H, D, c.x, H / 2, c.z, mat(0x8a93a1)));
    this.building.push(add(W + 0.8, 0.5, D + 0.8, c.x, H + 0.25, c.z, mat(0x4a5361)));
    this.building.push(add(W + 0.02, 1.0, D + 0.02, c.x, H * 0.55, c.z, mat(0x1d3a52, { roughness: 0.3, metalness: 0.4 }))); // 창 띠
    this.building.push(add(3.2, 3.4, 0.5, c.x, 1.7, c.z + D / 2 + 0.2, mat(0x2f6f9f))); // 출입구
    for (let i = -1; i <= 1; i++) this.building.push(add(2.4, 1.4, 2.4, c.x + i * (W / 4), H + 1.2, c.z - D / 4, mat(0x5b6675))); // 지붕 설비
    this.beacon = add(1.0, 1.0, 1.0, c.x, H + 1.5, c.z + D / 4, new THREE.MeshBasicMaterial({ color: 0x19cc4d }));
    this.building.push(this.beacon);
    // 메인 건물이 눈에 띄도록 옥상 표시등에 빛 번짐을 붙인다(상태 색을 따라간다)
    this.beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x19cc4d, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.beaconGlow.scale.set(26, 26, 1);
    this.beaconGlow.renderOrder = 6;
    g.add(this.beaconGlow);
    this._extR = Math.max(W, D);
    this._extH = H;
    g.visible = false;
    this.exterior = g;
    this.scene.add(g);
    // 도심: 가운데 블록(데이터센터)을 빼고 주변에 도로, 건물, 가로수, 차량
    this.city = buildCity({ cx: c.x, cz: c.z, quality: this.q });
    g.add(this.city.group);
    this.ground.material.color.set(0x6a6c6f); // 도로 사이 빈 바닥은 포장 색
    this.setSky(this.skyName ?? 'day');
  }

  // 하늘에서 반사 지도를 만들어 유리와 금속에 비춘다(외관 단계에서만). 낮은 화질에서는 만들지 않는다.
  // 반사 지도는 장면 전체(scene.environment)에 걸지 않고, 유리와 금속 재질에만 직접 지정한다.
  // 장면 전체에 걸면 거친 바닥(아스팔트, 인도, 도로)에도 하늘 빛이 들어가 보는 각도에 따라 바닥 색이 달라진다.
  _updateReflection() {
    this.scene.environment = null;
    if (!this.q.reflection) {
      this._envRT?.dispose();
      this._envRT = null;
      this._applyEnvMaps();
      return;
    }
    this._pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const mini = new THREE.Scene();
    mini.add(new THREE.Mesh(this.sky.geometry, this.sky.material));
    const old = this._envRT;
    this._envRT = this._pmrem.fromScene(mini, 0, 0.1, 2500);
    this._applyEnvMaps();
    old?.dispose();
  }

  // 반사할 재질(유리, 금속) 목록에 지도를 걸거나 뺀다. 목록: 건물 모델과 도시의 {mat, k(세기)}
  _applyEnvMaps() {
    const tex = this._envRT?.texture ?? null;
    for (const { mat, k } of [...(this._reflective ?? []), ...(this.city?.reflective ?? [])]) {
      mat.envMap = tex;
      mat.envMapIntensity = k;
      mat.needsUpdate = true;
    }
    this._dirty = true;
  }

  // 화질을 한 단계 낮춘다(프레임이 낮을 때). 도시 규모(건물 수)는 그대로 두고 나머지를 줄인다.
  applyQuality(tier) {
    const q = SETTINGS[tier];
    if (!q) return;
    this.tier = tier;
    this.q = { ...this.q, ...q, cityRings: this.q.cityRings };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.setSize(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight, false);
    this.sunExt.castShadow = q.shadow > 0;
    if (q.shadow > 0) {
      this.sunExt.shadow.map?.dispose();
      this.sunExt.shadow.map = null;
      this.sunExt.shadow.mapSize.set(q.shadow, q.shadow);
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.city?.setCounts(q.cars, q.trees);
    this.airflow?.setActive(q.particles);
    if (!q.reflection) this._updateReflection();
    this._dirty = true;
  }

  // 하늘 시간대(day, dusk): 하늘 색, 해 방향과 빛, 안개, 풀 색을 한꺼번에 바꾼다.
  setSky(name) {
    const p = SKY_PRESETS[name] ?? SKY_PRESETS.day;
    this.skyName = SKY_PRESETS[name] ? name : 'day';
    const dir = sunVector(p.elev, p.azim);
    const u = this.sky.material.uniforms;
    u.zenith.value.set(p.zenith);
    u.horizon.value.set(p.horizon);
    u.sunColor.value.set(p.sun);
    u.groundColor.value.set(p.grass).multiplyScalar(0.5);
    u.sunDir.value.copy(dir);
    this.sunExt.color.set(p.sun);
    this.sunExt.intensity = p.sunI;
    this.sunExt.position.copy(this.center).addScaledVector(dir, 250);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiI;
    this.hills.material.color.set(p.grass).multiplyScalar(0.8);
    this.city?.setSky(this.skyName);
    this._updateReflection();
    this.fogColor = new THREE.Color(p.fog);
    this.renderer.shadowMap.needsUpdate = true;
    if (this.stage === 'exterior') this.scene.fog = new THREE.FogExp2(this.fogColor, 0.0014);
    this._dirty = true;
  }

  // 카메라의 가까운 면(near)을 멀리 볼수록 키워 깊이 정밀도를 높인다(깊이 값은 near에 거의 비례해 정밀해진다).
  // 홀에서는 가까운 장비를 보므로 0.3 m 고정. depthOverride는 정밀도가 낮은 기기를 흉내 내는 시험용 [near, far].
  _updateDepthRange() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const [near, far] = this.depthOverride ?? [this.stage === 'exterior' ? Math.min(Math.max(d * 0.004, 0.5), 8) : 0.3, 2500];
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05 || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  // 건물 모델(glb)을 받아 단순 상자 건물을 바꾼다. 실패하면 상자로 계속 쓴다.
  async loadExteriorModel(baseUrl, onProgress) {
    const draco = new DRACOLoader().setDecoderPath(`${baseUrl}draco/`); // 메시 압축 해제기는 public/draco에 둔다
    const loader = new GLTFLoader().setDRACOLoader(draco);
    let gltf;
    try {
      gltf = await loader.loadAsync(`${baseUrl}models/building.glb`, onProgress);
    } finally {
      draco.dispose();
    }
    const meshes = mergeByMaterial(gltf.scene, CM);
    for (const m of meshes) {
      // 바닥에 겹친 면(주차선, 횡단보도)만 깊이 값 6단계만큼 앞으로 당긴다. 기울기에 비례하는 값(factor)은 쓰지 않는다:
      // 낮은 각도에서 값이 커져 아스팔트가 아래 바닥 뒤로 밀려나는 문제가 있었다. 단계(units)는 기기의 깊이 정밀도에 맞춰 자동으로 조절된다.
      const n = m.material.name || '';
      const k = envIntensityFor(n);
      if (k > 0) {
        // 유리와 금속만 반사하는 재질로 둔다. 유리는 짙은 색에 반사가 강하고 거의 불투명하게 해서 안쪽 벽이 비치지 않게 한다.
        if (/Glass/i.test(n)) Object.assign(m.material, { color: new THREE.Color(0x35506a), metalness: 0.3, roughness: 0.05, opacity: 0.9, transparent: true });
        (this._reflective ??= []).push({ mat: m.material, k });
      } else {
        m.material = toLambert(m.material); // 바닥, 콘크리트, 지붕, 울타리, 식재: 보는 각도에 따라 색이 변하지 않는 재질
      }
      if (/Paint|Crosswalk/i.test(n)) Object.assign(m.material, { polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -6 });
    }
    const box = new THREE.Box3();
    for (const m of meshes) box.union(m.geometry.boundingBox);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    const c = this.center;
    const model = new THREE.Group();
    for (const m of meshes) model.add(m);
    this._applyEnvMaps();
    model.position.set(c.x - mid.x, 0, c.z - mid.z); // 건물 가운데를 홀 가운데에 맞춘다
    this.exterior.add(model);
    for (const b of this.building) b.visible = false; // 상자는 숨기고 클릭 판정에만 쓴다
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(c.x, size.y / 2, c.z);
    this.exterior.add(proxy);
    this.building = [proxy];
    this.beacon.visible = true;
    this.beacon.position.set(c.x, size.y + 2, c.z);
    this.beaconGlow.position.copy(this.beacon.position);
    this.exteriorModel = model;
    this.renderer.shadowMap.needsUpdate = true;
    this._extR = Math.max(size.x, size.z) * 0.9;
    this._extH = size.y;
    if (this.stage === 'exterior') {
      this._applyLimits('exterior');
      this.setPreset('ext', true);
    }
    this._dirty = true;
    return meshes.length;
  }

  // 건물을 가리키는지(외관 단계에서 클릭과 손모양 표시에 쓴다)
  pickBuilding(nx, ny) {
    if (this.stage !== 'exterior') return false;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    return ray.intersectObjects(this.building, false).length > 0;
  }

  _applyLimits(stage) {
    const ext = stage === 'exterior';
    this.controls.minDistance = ext ? 10 : 2;
    this.controls.maxDistance = ext ? this._extR * 4.5 : 45;
    this.controls.maxPolarAngle = Math.PI * (ext ? 0.48 : 0.49);
  }

  // 외관과 홀을 바꾼다. 카메라는 0.8초 동안 옮기고(동작 줄이기면 바로), 이동 중에는 거리 제한을 풀어 둔다.
  setStage(stage, instant = false) {
    if (stage !== 'exterior' && stage !== 'hall') return;
    this.stage = stage;
    const ext = stage === 'exterior';
    this.renderer.shadowMap.needsUpdate = true;
    this.hall.visible = !ext;
    this.hallLights.visible = !ext;
    this.exterior.visible = ext;
    this.scene.background = ext ? null : new THREE.Color(0x0e1218);
    this.scene.fog = ext ? new THREE.FogExp2(this.fogColor, 0.0014) : null;
    this.hover(null);
    for (const l of this.labels) l.el.hidden = ext || !this.showLabels;
    const moving = !(instant || this.reducedMotion);
    if (moving) {
      this.controls.minDistance = 2;
      this.controls.maxDistance = this._extR * 4.5;
    } else {
      this._applyLimits(stage);
    }
    this.setPreset(ext ? 'ext' : 'home', instant, 0.8);
    if (moving && this._anim) this._anim.onDone = () => this._applyLimits(stage);
    this._dirty = true;
  }

  // 통로 이름: 차가운 통로는 급기구 열의 가운데, 뜨거운 통로는 지붕 패널의 가운데
  _buildLabels(data) {
    const items = [];
    const cold = new Map();
    data.vents.forEach((v) => {
      const k = Math.round((v.min[1] + v.max[1]) / 2);
      const e = cold.get(k) ?? { xs: [], y: k };
      e.xs.push((v.min[0] + v.max[0]) / 2);
      cold.set(k, e);
    });
    [...cold.values()]
      .sort((a, b) => a.y - b.y)
      .forEach((e, i) => items.push({ text: `차가운 통로 ${i + 1}`, pos: toThree(e.xs.reduce((a, b) => a + b, 0) / e.xs.length, e.y, 5), cls: 'cold' }));
    data.panels
      .filter((p) => p.name.endsWith('_Roof'))
      .forEach((p) => items.push({ text: `뜨거운 통로 ${Number(/HotAisle_(\d+)/.exec(p.name)?.[1])}`, pos: toThree((p.min[0] + p.max[0]) / 2, (p.min[1] + p.max[1]) / 2, 215), cls: 'hot' }));
    for (const it of items) {
      const el = document.createElement('div');
      el.className = `aisle-label ${it.cls}`;
      el.textContent = it.text;
      el.hidden = true;
      this.labelLayer.appendChild(el);
      this.labels.push({ ...it, el });
    }
  }

  // ---- 조작 ----
  setView(view) {
    if (!VIEWS[view]) return;
    this.view = view;
    this._dirty = true;
  }

  setLabels(on) {
    this.showLabels = on;
    for (const l of this.labels) l.el.hidden = !on || this.stage !== 'hall';
  }

  setPreset(name, instant = false, dur = 0.6) {
    const c = this.center;
    const presets = {
      top: { pos: new THREE.Vector3(c.x, 19, c.z + 0.01), target: c.clone() },
      iso: { pos: new THREE.Vector3(c.x - 9, 10, c.z + 11), target: new THREE.Vector3(c.x, 0.3, c.z) },
    };
    if (this._extR) {
      const r = this._extR;
      presets.ext = { pos: new THREE.Vector3(c.x + r * 0.95, r * 0.5, c.z + r * 1.2), target: new THREE.Vector3(c.x, this._extH / 2, c.z) };
    }
    presets.home = { pos: new THREE.Vector3(c.x + 8, 10, c.z + 12), target: new THREE.Vector3(c.x, 0.3, c.z) };
    const p = presets[name] ?? presets.home;
    this._moveCamera(p.pos, p.target, instant, dur);
  }

  _moveCamera(pos, target, instant, dur = 0.6) {
    if (instant || this.reducedMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this._anim = null;
      return;
    }
    this._anim = { t: 0, dur, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), pos, target };
  }

  // 장비(rack_01, crac_01 ...)로 카메라를 옮긴다(FR-40)
  focus(equipment) {
    const box = this._boxOf(equipment);
    if (!box) return;
    const c = this._worldCenter(box);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this._moveCamera(c.clone().add(dir.multiplyScalar(6)), c, false);
  }

  _boxOf(equipment) {
    const ri = this.rackKeys.indexOf(equipment);
    if (ri >= 0) return this.data.racks[ri];
    const ci = this.cracKeys.indexOf(equipment);
    return ci >= 0 ? this.data.cracs[ci] : null;
  }

  _worldCenter(b) {
    return toThree((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  }

  select(equipment) {
    this.selected = equipment;
    this._placeBox(this.selBox, equipment);
  }

  hover(equipment) {
    if (this.hovered === equipment) return;
    this.hovered = equipment;
    this._placeBox(this.hoverBox, equipment && equipment !== this.selected ? equipment : null);
  }

  _placeBox(box, equipment) {
    const b = equipment && this._boxOf(equipment);
    if (!b) {
      box.visible = false;
      return;
    }
    const m = this._boxMatrix(b, 0.08);
    m.decompose(box.position, box.quaternion, box.scale);
    box.visible = true;
  }

  // 화면 위치(캔버스 안 0~1 좌표)에 있는 장비를 찾는다
  pick(nx, ny) {
    if (this.stage !== 'hall') return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    const hits = ray.intersectObjects([this.rackBody, this.rackFront, this.cracBody, this.cracFront], false);
    if (!hits.length) return null;
    const h = hits[0];
    if (h.object === this.rackBody || h.object === this.rackFront) return this.rackKeys[h.instanceId] ?? null;
    return this.cracKeys[h.instanceId] ?? null;
  }

  // 장비의 화면 위치(픽셀). 말풍선 위치에 쓴다
  screenOf(equipment, canvas) {
    const b = this._boxOf(equipment);
    if (!b) return null;
    const v = this._worldCenter(b).clone();
    v.y = (b.max[2] * CM) + 0.2;
    v.project(this.camera);
    const r = canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, behind: v.z > 1 };
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  // ---- 갱신 ----
  _paint(timeSec) {
    const { store } = this;
    const view = VIEWS[this.view];
    const c = new THREE.Color();
    let anyCritical = false;
    let worst = 'normal';
    for (let i = 0; i < this.rackKeys.length; i++) {
      const key = this.rackKeys[i];
      const sample = store.metric(key, view.metric);
      const [r, g, b] = sampleColor(sample, view.cold, view.hot);
      this.rackFront.setColorAt(i, c.setRGB(r, g, b));
      this.rackTop.setColorAt(i, c);

      const alarm = store.worstAlarm(key);
      if (alarm === 'critical' || (alarm === 'warn' && worst === 'normal')) worst = alarm;
      if (alarm === 'normal') {
        this.rackHull.setMatrixAt(i, ZERO);
      } else {
        const [ar, ag, ab] = ALARM_COLOR[alarm];
        let f = 1;
        if (alarm === 'critical') {
          anyCritical = true;
          f = this.reducedMotion ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(Math.PI * timeSec)); // 0.5 Hz
        }
        this.rackHull.setColorAt(i, c.setRGB(ar * f, ag * f, ab * f));
        const m = this._boxMatrix(this.data.racks[i], 0.1);
        this.rackHull.setMatrixAt(i, m);
      }

      // 신뢰 막대(입구 온도 보기에서만)
      const tIn = this.view === 'temp_in' ? store.metric(key, 'temp_in') : null;
      const frac = tIn ? barFraction(tIn) : 0;
      if (frac > 0) {
        const rc = this._rackCenter[i];
        const trackLen = 0.54;
        const track = new THREE.Matrix4().compose(new THREE.Vector3(rc.x, rc.y + 0.2, rc.z), new THREE.Quaternion(), new THREE.Vector3(trackLen, 0.07, 0.2));
        this.barTrack.setMatrixAt(i, track);
        const len = trackLen * frac;
        const bm = new THREE.Matrix4().compose(new THREE.Vector3(rc.x - (trackLen - len) / 2, rc.y + 0.2, rc.z), new THREE.Quaternion(), new THREE.Vector3(len, 0.11, 0.26));
        this.bar.setMatrixAt(i, bm);
        const [cr, cg, cb] = confidenceColor(tIn.confidence);
        this.bar.setColorAt(i, c.setRGB(cr, cg, cb));
      } else {
        this.barTrack.setMatrixAt(i, ZERO);
        this.bar.setMatrixAt(i, ZERO);
      }
    }
    for (let i = 0; i < this.cracKeys.length; i++) {
      const alarm = store.worstAlarm(this.cracKeys[i]);
      if (alarm === 'critical' || (alarm === 'warn' && worst === 'normal')) worst = alarm;
      const [r, g, b] = alarm === 'normal' ? CRAC_OK : ALARM_COLOR[alarm];
      this.cracFront.setColorAt(i, c.setRGB(r, g, b));
    }
    for (const m of [this.rackFront, this.rackTop, this.rackHull, this.bar, this.cracFront]) m.instanceColor.needsUpdate = true;
    for (const m of [this.rackHull, this.barTrack, this.bar]) m.instanceMatrix.needsUpdate = true;
    if (this.beacon) {
      const rgb = worst === 'normal' ? [0.1, 0.8, 0.3] : ALARM_COLOR[worst];
      this.beacon.material.color.setRGB(...rgb);
      this.beaconGlow?.material.color.setRGB(...rgb);
    }
    this._blink = anyCritical && !this.reducedMotion;
  }

  update(dtSec, timeSec) {
    if (this._anim) {
      const a = this._anim;
      a.t = Math.min(a.t + dtSec / a.dur, 1);
      const e = a.t * a.t * (3 - 2 * a.t);
      this.camera.position.lerpVectors(a.fromPos, a.pos, e);
      this.controls.target.lerpVectors(a.fromTarget, a.target, e);
      if (a.t >= 1) {
        this._anim = null;
        a.onDone?.();
      }
    }
    this.controls.update();
    this._updateDepthRange();
    if (!this.cctv) this._updateShell();
    this._stepAirflow(dtSec, timeSec);
    if (this.stage === 'exterior') {
      this.city?.update(this.reducedMotion ? 0 : dtSec);
      this.sky.material.uniforms.time.value = timeSec;
    }
    if (this._dirty || this.store.version !== this._lastVersion || this._blink) {
      this._paint(timeSec);
      this._lastVersion = this.store.version;
      this._dirty = false;
    }
    if (this.showLabels && this.stage === 'hall' && !this.cctv) {
      const r = this.renderer.domElement.getBoundingClientRect();
      for (const l of this.labels) {
        const v = l.pos.clone().project(this.camera);
        const hide = v.z > 1;
        l.el.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px) translate(-50%, -50%)`;
        l.el.style.visibility = hide ? 'hidden' : 'visible';
      }
    }
    if (this.cctv && this.stage === 'hall') this._renderCctv(timeSec);
    else this.renderer.render(this.scene, this.camera);
  }

  // 시험과 점검용: 지금 랙 앞면 색(선형 RGB)
  rackFrontColor(i) {
    const c = new THREE.Color();
    this.rackFront.getColorAt(i, c);
    return [c.r, c.g, c.b];
  }

  dispose() {
    this.renderer.dispose();
    for (const l of this.labels) l.el.remove();
  }
}
