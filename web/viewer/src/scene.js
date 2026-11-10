// Three.js 장면 (docs/18 5.1, 5.3장). 랙은 InstancedMesh 묶음으로 그리고 값은 인스턴스 색으로 칠한다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SKY_PRESETS, makeHills, makeSky, mergeByMaterial, sunVector } from './env.js';
import { Airflow, loadFlow } from './airflow.js';
import { CITY, buildCity } from './city.js';
import { prepareShell, shellVisibility } from './hall_shell.js';
import { CCTV_LIMITS } from './cctv.js';
import { VIEWS } from './views.js';
import { SETTINGS, pixelRatioFor } from './quality.js';
import { Fx } from './fx.js';
import { detailTexture, mulberry32 } from './citytex.js';
import { filterTriangles, siteTreeGeometries, trunkCenters } from './trees.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
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
  constructor(canvas, labelLayer, data, store, { reducedMotion = false, stage = 'hall', tier = 'high', fx = null } = {}) {
    this.tier = tier;
    this.fxMode = fx; // 'on' | 'off' | null(자동)
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio)); // 크기가 정해지면 resize에서 화소 수 상한에 맞춘다
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
    // 조작: 왼쪽 버튼 하나로 처리한다. 끌면 회전, 짧게 누르면 선택(main.js가 5px 넘게 움직이면 선택으로 보지 않는다). 휠은 확대.
    // 자유 이동(팬)은 없고 오른쪽 버튼은 쓰지 않는다. 회전 중심은 항상 데이터센터 중심이다.
    this.controls.enablePan = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
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
    this._setupFx();
    this._refreshSkyForFx();
    this._applyAniso();
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
    // 뜨거운 통로 격벽(HAC): 옆판은 옅게, 지붕은 조금 진하게, 모든 판에 테두리 선을 둘러 잘 보이게 한다(2026-11-10 사용자 요청)
    const roofs = data.panels.filter((p) => p.name.endsWith('_Roof'));
    const sides = data.panels.filter((p) => !p.name.endsWith('_Roof'));
    const panels = boxMesh(sides, new THREE.MeshStandardMaterial({ color: 0x6fa8e0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    panels.renderOrder = 2;
    const roofMesh = boxMesh(roofs, new THREE.MeshStandardMaterial({ color: 0x6fa8e0, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide }));
    roofMesh.renderOrder = 2;
    const edgeGeos = data.panels.map((p) => {
      const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      g.applyMatrix4(this._boxMatrix(p));
      return g;
    });
    const edges = new THREE.LineSegments(mergeGeometries(edgeGeos, false), new THREE.LineBasicMaterial({ color: 0x8fc0f0, transparent: true, opacity: 0.85 }));
    edgeGeos.forEach((g) => g.dispose());
    edges.renderOrder = 3;
    edges.name = 'containmentEdges';
    this.hall.add(edges);
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
    // CCTV는 실제 카메라처럼 장비만 보인다: 선택 상자, 온도 색칠, 신뢰 막대, 알람 테두리와 링, 공기 흐름 입자(시뮬레이션 표현)를 잠시 끈다.
    const sim = [this.selBox, this.hoverBox, this.rackFront, this.rackTop, this.cracFront, this.barTrack, this.bar, this.rackHull, this._rings, this.airflow?.points].filter(Boolean);
    const hiddenHelpers = sim.map((o) => [o, o.visible]);
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
    this._extR = Math.max(W, D);
    this._bldg = { center: new THREE.Vector3(c.x, H / 2, c.z), half: new THREE.Vector3(W / 2, H / 2, D / 2) };
    this._main = this._bldg; // 데이터센터 건물 한 동(호버, 선택, 외곽선 기준). 모델을 받으면 지붕 면적으로 다시 정한다
    this._tagAnchor = new THREE.Vector3(c.x, H + 4, c.z); // 이름·상태 표시가 붙는 점(건물 위)
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
    const dec = this.sky.material.uniforms.uDecode.value;
    this.sky.material.uniforms.uDecode.value = 0; // 반사 지도는 화면 변환을 거치지 않은 선형 값이다
    this._envRT = this._pmrem.fromScene(mini, 0, 0.1, 2500);
    this.sky.material.uniforms.uDecode.value = dec;
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
    this._applySize(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight);
    this._setupFx();
    this._refreshSkyForFx();
    this._applyAniso();
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
    u.uDecode.value = this.fx ? 1 : 0; // 후처리 중에는 화면 변환을 한 번 더 거치므로 하늘 셰이더가 값을 미리 푼다
    u.sunDir.value.copy(dir);
    this.sunExt.color.set(p.sun);
    this.sunExt.intensity = p.sunI;
    this.sunExt.position.copy(this.center).addScaledVector(dir, 250);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiI;
    this.hills.material.color.set(p.grass).multiplyScalar(0.8);
    this.city?.setSky(this.skyName);
    if (this._siteLights) this._siteLights.visible = this.skyName === 'dusk';
    this._nightU.value = this.skyName === 'dusk' ? 1 : 0; // 데이터센터 창에 불이 켜진다
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

  get _nightU() {
    return (this._nightUniform ??= { value: 0 });
  }

  // 저녁에 유리 창 일부(약 55%)가 따뜻한 불빛으로 켜진다. 창 위치는 월드 좌표를 칸(수평 2.4 m x 층 3.6 m)으로 나눠 해시로 고르므로
  // 그림 파일이 필요 없고 건물이 움직여도 같은 창이 켜진다. 낮에는 uNight가 0이라 아무 일도 없다.
  _lightWindows(mat) {
    const u = this._nightU;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = u;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        varying vec3 vWp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vWp;
        uniform float uNight;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec2 wCell() { return vec2(floor((vWp.x + vWp.z) / 2.5), floor(vWp.y / 3.6)); }`)
        // 낮: 창마다 색 농도가 조금씩 다르고(±12%), 위로 갈수록 하늘이 더 비쳐 밝으며, 층 사이 띠(바닥 슬래브)는 어둡다
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 c0 = wCell();
          float hv = h21(c0);
          float up = clamp(vWp.y / 16.0, 0.0, 1.0);
          float slab = 1.0 - smoothstep(0.0, 0.32, abs(mod(vWp.y, 3.6) - 0.25));
          diffuseColor.rgb *= (0.88 + 0.24 * hv) * (0.9 + 0.3 * up);
          diffuseColor.rgb *= 1.0 - 0.45 * slab;
          diffuseColor.rgb += vec3(0.0, 0.02, 0.025) * h21(c0 + 5.0); // 일부 창은 약간 청록
        }`)
        // 창마다 반사가 부드러운 정도가 다르다(0.04~0.16): 어떤 창은 하늘이 또렷하고 어떤 창은 번진다
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.04, 0.16, h21(wCell() + 3.0));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec2 cell = wCell();
        // 창의 40 %만 켠다. 무작위 문턱은 켜진 창이 뭉치므로 황금비 격자(R2 수열)로 고르게 흩고, 창마다 작은 흔들림으로 규칙 무늬를 피한다.
        float ru = fract(dot(cell, vec2(0.7548776662, 0.5698402910)) + 0.3 * h21(cell + 11.0));
        float lit = step(ru, 0.4) * (0.45 + 0.55 * h21(cell + 7.0));
        float onFloor = step(0.4, vWp.y);
        totalEmissiveRadiance += vec3(1.0, 0.74, 0.4) * lit * onFloor * uNight * 0.6;`);
    };
    mat.customProgramCacheKey = () => 'dc-glass-windows-v4';
    mat.needsUpdate = true;
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
        if (/Glass/i.test(n)) {
          this._lightWindows(m.material);
          m.material.depthWrite = true; // 유리가 깊이를 써야 건물 뒤쪽 외곽 강조선이 유리를 뚫고 비치지 않는다
        }
        (this._reflective ??= []).push({ mat: m.material, k });
      } else {
        m.material = toLambert(m.material); // 바닥, 콘크리트, 지붕, 울타리, 식재: 보는 각도에 따라 색이 변하지 않는 재질
      }
      // 건물 모델의 단조로운 면에 미세 디테일: 콘크리트, 지붕, 아스팔트, 금속 패널, 벽 안쪽
      if (/Concrete/i.test(n)) this._addDetail(m.material, { scale: 0.45, amt: 0.3, bump: 0.025 });
      else if (/Roof/i.test(n)) {
        this._addDetail(m.material, { scale: 0.6, amt: 0.4, bump: 0.03 });
        this._roofDetail(m.material);
      }
      else if (/Asphalt/i.test(n)) {
        this._addDetail(m.material, { scale: 0.9, amt: 0.65, bump: 0.05 });
        this._asphaltDetail(m.material);
      } else if (/ParkingPaint/i.test(n)) this._addDetail(m.material, { scale: 1.4, amt: 0.55, bump: 0.02 }); // 주차선: 바랜 느낌
      else if (/OutdoorEquip/i.test(n)) this._addDetail(m.material, { scale: 1.0, amt: 0.3, bump: 0.02 });
      else if (/Foliage/i.test(n)) this._addDetail(m.material, { scale: 2.2, amt: 0.5, bump: 0.04 }); // 생울타리 잎의 거친 느낌
      else if (/PanelMetal/i.test(n)) this._addDetail(m.material, { scale: 1.2, amt: 0.25, bump: 0.015 });
      else if (/WallCore/i.test(n)) this._addDetail(m.material, { scale: 0.5, amt: 0.35, bump: 0.03 });
      if (/Paint|Crosswalk/i.test(n)) Object.assign(m.material, { polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -6 });
    }
    const box = new THREE.Box3();
    for (const m of meshes) box.union(m.geometry.boundingBox);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    const c = this.center;
    // 건물 본체와 옥외 설비(부지 바닥, 울타리, 주차장 제외)의 범위: 확대해도 이 안으로 카메라가 들어가지 못하게 한다
    const bb = new THREE.Box3();
    for (const m of meshes) if (/Bldg(?!FloorProxy)|OutdoorEquip/.test(m.material.name || '')) bb.union(m.geometry.boundingBox);
    if (!bb.isEmpty()) {
      bb.min.add(new THREE.Vector3(c.x - mid.x, 0, c.z - mid.z));
      bb.max.add(new THREE.Vector3(c.x - mid.x, 0, c.z - mid.z));
      this._bldg = { center: bb.getCenter(new THREE.Vector3()), half: bb.getSize(new THREE.Vector3()).multiplyScalar(0.5) };
    }
    // 데이터센터 건물 한 동: 지붕(M_BldgRoof) 면적과 높이로 정한다. 호버와 클릭 판정, 외곽선은 이 상자만 쓴다(옥외 설비, 수위실 같은 부속 건물은 제외).
    const off = new THREE.Vector3(c.x - mid.x, 0, c.z - mid.z);
    const roof = meshes.find((m) => /BldgRoof/.test(m.material.name || ''));
    if (roof) {
      const rb = roof.geometry.boundingBox.clone();
      rb.min.add(off);
      rb.max.add(off);
      const top = rb.max.y + 0.5;
      const sz = rb.getSize(new THREE.Vector3());
      const ctr = rb.getCenter(new THREE.Vector3());
      this._main = { center: new THREE.Vector3(ctr.x, top / 2, ctr.z), half: new THREE.Vector3(sz.x / 2 + 0.8, top / 2, sz.z / 2 + 0.8) };
    } else {
      this._main = this._bldg;
    }
    // 설비 보강: 냉각탑 김, 울타리 윗줄의 가시철사
    const extras = this._buildEquipmentExtras(gltf.scene);
    // 저녁 조명: 모델의 가로등(LightPole_*) 위치에 빛 번짐과 바닥 빛 웅덩이를 둔다(저녁에만 보임)
    const roofM = meshes.find((m) => /BldgRoof/.test(m.material.name || ''));
    const siteLights = this._buildSiteLights(gltf.scene, roofM?.geometry.boundingBox ?? null);
    // 부지 나무 교체: 줄기 위치를 찾아 모델의 나무(줄기와 수관)를 지우고 상세 나무를 같은 자리에 세운다. 생울타리 같은 낮은 식재는 남긴다.
    let siteTrees = null;
    const trunkM = meshes.find((m) => /Trunk/.test(m.material.name || ''));
    const foliageM = meshes.find((m) => /Foliage/.test(m.material.name || ''));
    if (trunkM && foliageM) {
      const spots = trunkCenters(trunkM.geometry);
      if (spots.length) {
        foliageM.geometry = filterTriangles(foliageM.geometry, (x, y, z) => !(y > 1.8 && spots.some((p) => Math.hypot(p.x - x, p.z - z) < 3.6)));
        meshes.splice(meshes.indexOf(trunkM), 1);
        siteTrees = this._buildSiteTrees(spots);
      }
    }
    if (this._roofU) this._roofU.value.set(this._main.center.x, this._main.center.z, this._main.half.x - 0.8, this._main.half.z - 0.8);
    const model = new THREE.Group();
    for (const m of meshes) model.add(m);
    if (siteTrees) model.add(siteTrees);
    if (extras) {
      model.add(extras);
      this._extras = extras;
    }
    if (siteLights) {
      model.add(siteLights);
      this._siteLights = siteLights;
      siteLights.visible = this.skyName === 'dusk';
    }
    this._applyEnvMaps();
    model.position.set(c.x - mid.x, 0, c.z - mid.z); // 건물 가운데를 홀 가운데에 맞춘다
    this.exterior.add(model);
    for (const b of this.building) b.visible = false; // 상자는 숨기고 클릭 판정에만 쓴다
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(this._main.half.x * 2, this._main.half.y * 2, this._main.half.z * 2), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.copy(this._main.center);
    this.exterior.add(proxy);
    this.building = [proxy];
    this.exteriorModel = model;
    this._applyAniso();
    this._tagAnchor = new THREE.Vector3(this._main.center.x, this._main.center.y + this._main.half.y + 4, this._main.center.z);
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

  // ---- 화면 나눠 비교: 왼쪽은 저장한 기준의 랙 색, 오른쪽은 지금 색을 같은 카메라로 그린다 ----
  // 보는 값 3종(입구 온도, 배기 온도, 전력) 각각의 랙 색을 저장해 두므로 나눠 비교 중에 보는 값을 바꿔도 맞는다.
  saveBaselineColors() {
    const { store } = this;
    this._base = {};
    for (const [key, view] of Object.entries(VIEWS)) {
      const arr = new Float32Array(this.rackKeys.length * 3);
      this.rackKeys.forEach((rk, i) => {
        const [r, g, b] = sampleColor(store.metric(rk, view.metric), view.cold, view.hot);
        arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b;
      });
      this._base[key] = arr;
    }
  }

  get splitFraction() {
    return this._splitF ?? 0.5;
  }

  setSplit(on) {
    this._split = on && this._base ? this.splitFraction : 0;
    this._dirty = true;
  }

  setSplitFraction(f) {
    this._splitF = Math.min(Math.max(f, 0.08), 0.92);
    if (this._split) this._split = this._splitF;
    this._dirty = true;
  }

  _renderSplit() {
    const r = this.renderer;
    const c = r.domElement;
    const W = c.clientWidth, H = c.clientHeight;
    const arrs = [this.rackFront.instanceColor, this.rackTop.instanceColor];
    const cur = arrs.map((a) => a.array.slice());
    const base = this._base[this.view];
    let diff = 0;
    for (let i = 0; i < base.length; i++) diff += Math.abs(base[i] - cur[0][i]);
    this._splitDiff = diff / base.length; // 기준과 지금의 평균 색 차이(시험과 점검용)
    const x = Math.round(W * this._split);
    r.setScissorTest(true);
    r.setViewport(0, 0, W, H);
    arrs.forEach((a) => { a.array.set(base); a.needsUpdate = true; });
    const draw = () => (this.fx ? this.fx.render() : r.render(this.scene, this.camera));
    r.setScissor(0, 0, x, H);
    draw();
    arrs.forEach((a, i) => { a.array.set(cur[i]); a.needsUpdate = true; });
    r.setScissor(x, 0, W - x, H);
    draw();
    r.setScissorTest(false);
  }

  // 외관에서 데이터센터 건물 한 동의 모서리를 따라 하늘색 외곽 강조선을 낸다(홀 안 선택 상자와 같은 색).
  // 건물 모델 전체가 아니라 건물 본체 상자(_main)의 12개 모서리를 굵은 선(LineSegments2, 화면 3px)으로 그린다. 가려진 쪽은 건물에 가려진다.
  setBuildingHover(on) {
    if (!on) {
      if (this._bHover?.visible) {
        this._bHover.visible = false;
        this._dirty = true;
      }
      return;
    }
    if (!this._main) return;
    if (!this._bHover || this._bHoverFor !== this._main) {
      if (this._bHover) {
        this.exterior.remove(this._bHover);
        this._bHover.geometry.dispose();
        this._bHover.material.dispose();
      }
      const { center, half } = this._main;
      const box = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
      const geo = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(box));
      box.dispose();
      const mat = new LineMaterial({ color: 0x4fd8ff, linewidth: 3 * (this.pixelRatio ?? 1), worldUnits: false });
      const c = this.renderer.domElement;
      mat.resolution.set((c.clientWidth || 1) * (this.pixelRatio ?? 1), (c.clientHeight || 1) * (this.pixelRatio ?? 1));
      const lines = new LineSegments2(geo, mat);
      lines.position.copy(center);
      lines.renderOrder = 7;
      this.exterior.add(lines);
      this._bHover = lines;
      this._bHoverFor = this._main;
    }
    if (!this._bHover.visible) this._dirty = true;
    this._bHover.visible = true;
  }

  // 이름·상태 표시를 붙일 점의 화면 위치(캔버스 안 픽셀). 외관이 아니면 null
  buildingTagScreen(canvas) {
    if (this.stage !== 'exterior' || !this._tagAnchor) return null;
    const v = this._tagAnchor.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }

  // 건물을 가리키는지(외관 단계에서 클릭과 손모양 표시에 쓴다)
  pickBuilding(nx, ny) {
    if (this.stage !== 'exterior') return false;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    return ray.intersectObjects(this.building, false).length > 0;
  }

  // 멀리 보기 한계: 도시(블록 배치) 가장자리 밖이 화면에 들어오지 않도록, 도시 반폭의 45%와 건물 크기의 4.5배 중 작은 쪽
  _extMaxDistance() {
    const cityHalf = Math.min((this.q.cityRings + 0.5) * CITY.pitchX, (this.q.cityRings + 0.5) * CITY.pitchZ);
    return Math.min((this._extR ?? 100) * 4.5, cityHalf * 0.45);
  }

  // 가까이 보기 한계: 카메라가 건물(본체와 옥외 설비)의 안으로 들어가지 못하게, 건물 중심에서 나오는 시선이 건물 범위 밖(여유 4 m)에 닿는 곳까지만 다가간다
  _keepOutside() {
    if (this.stage !== 'exterior' || !this._bldg || this._anim) return;
    const { center, half } = this._bldg;
    const m = 4;
    const t = this.controls.target;
    const p = this.camera.position;
    const inside = (v) => Math.abs(v.x - center.x) < half.x + m && Math.abs(v.y - center.y) < half.y + m && Math.abs(v.z - center.z) < half.z + m;
    if (!inside(t) || !inside(p)) return;
    const dir = p.clone().sub(t);
    const len = dir.length();
    if (len < 1e-6) return;
    dir.divideScalar(len);
    let exit = Infinity;
    for (const a of ['x', 'y', 'z']) {
      if (Math.abs(dir[a]) < 1e-6) continue;
      const bound = dir[a] > 0 ? center[a] + half[a] + m - t[a] : t[a] - (center[a] - half[a] - m);
      exit = Math.min(exit, bound / Math.abs(dir[a]));
    }
    if (len < exit) p.copy(t).addScaledVector(dir, exit);
  }

  // 멀리 볼 때 카메라가 도시 건물 안으로 파고들지 않게 한다. 각도는 그대로 두고, 건물 중심에서 카메라로 이어지는 시선에서
  // 처음 닿는 도시 건물 앞(여유 2 m)까지만 물러난다. 건물 상자는 한 번만 모아 둔다.
  _keepOutOfCity() {
    if (this.stage !== 'exterior' || this._anim || !this.city) return;
    const boxes = (this._cityBoxes ??= this.city.plan.buildings.flatMap((b) => b.parts.map((q) => ({ x0: q.x - q.w / 2 - 2, x1: q.x + q.w / 2 + 2, z0: q.z - q.d / 2 - 2, z1: q.z + q.d / 2 + 2, top: q.y0 + q.h + 2 }))));
    const t = this.controls.target;
    const p = this.camera.position;
    if (p.y > 140) return; // 가장 높은 건물보다 위
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}`;
    if (key === this._cityKey) return; // 카메라가 그대로면 다시 검사하지 않는다
    this._cityKey = key;
    const dir = p.clone().sub(t);
    const len = dir.length();
    if (len < 1) return;
    dir.divideScalar(len);
    for (let d = 4; d <= len; d += 4) {
      const x = t.x + dir.x * d, y = t.y + dir.y * d, z = t.z + dir.z * d;
      if (boxes.some((q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1 && y < q.top)) {
        p.copy(t).addScaledVector(dir, Math.max(d - 4, 1));
        return;
      }
    }
  }

  _applyLimits(stage) {
    const ext = stage === 'exterior';
    this.controls.minDistance = ext ? 10 : 2;
    this.controls.maxDistance = ext ? this._extMaxDistance() : 45;
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
    this.setBuildingHover(false);
    for (const l of this.labels) l.el.hidden = ext || !this.showLabels;
    const moving = !(instant || this.reducedMotion);
    if (moving) {
      this.controls.minDistance = 2;
      this.controls.maxDistance = this._extMaxDistance();
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
      // 이름은 통로 가운데(랙 위에 겹쳐 보인다)가 아니라 통로 끝에 둔다: 차가운 통로는 동쪽 끝, 뜨거운 통로는 서쪽 끝, 바닥에서 3 m 위
      .forEach((e, i) => items.push({ text: `차가운 통로 ${i + 1}`, pos: toThree(Math.max(...e.xs) + 120, e.y, 300), cls: 'cold' }));
    data.panels
      .filter((p) => p.name.endsWith('_Roof'))
      .forEach((p) => items.push({ text: `뜨거운 통로 ${Number(/HotAisle_(\d+)/.exec(p.name)?.[1])}`, pos: toThree(p.min[0] - 60, (p.min[1] + p.max[1]) / 2, 300), cls: 'hot' }));
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

  // 건물 모델 재질 위에 미세 디테일을 겹친다(질감 해상도가 아니라 면의 단조로움을 줄이는 방법).
  // 월드 좌표를 면의 방향(위, 옆)에 맞춰 평면으로 투영해 두 크기로 읽는다: 밝기 곱하기 + 요철(화면 기울기 방식). 25 m까지 전부, 90 m에서 사라진다.
  // opts: { scale: 1 m당 반복 횟수, amt: 밝기 변화 세기, bump: 요철 세기 }
  _addDetail(mat, { scale = 0.5, amt = 0.4, bump = 0.03 } = {}) {
    const k = this.q.detail ?? 0;
    if (!(k > 0)) return;
    this._detailTex ??= detailTexture(this.q.detail >= 1 ? 512 : 256);
    const uniforms = { uDetail: { value: this._detailTex }, uDScale: { value: scale }, uDAmt: { value: amt * k }, uDBump: { value: bump * k } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        varying vec3 vDWp;
        varying vec3 vDWn;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDWp = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vDWn = normalize(mat3(modelMatrix) * normal);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vDWp;
        varying vec3 vDWn;
        uniform sampler2D uDetail;
        uniform float uDScale;
        uniform float uDAmt;
        uniform float uDBump;
        float dFade;
        vec2 dUv(vec3 p, vec3 n) {
          vec3 a = abs(n);
          if (a.y >= a.x && a.y >= a.z) return p.xz;
          if (a.x >= a.z) return p.zy;
          return p.xy;
        }
        float dHeight(vec3 p, vec3 n) {
          vec2 uv = dUv(p, n) * uDScale;
          return texture2D(uDetail, uv).r * 0.62 + texture2D(uDetail, uv * 5.3 + 0.37).r * 0.38;
        }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        dFade = 1.0 - smoothstep(25.0, 90.0, distance(cameraPosition, vDWp));
        float dH = dHeight(vDWp, normalize(vDWn));
        diffuseColor.rgb *= mix(1.0, clamp(dH * 2.0, 0.35, 1.7), uDAmt * dFade);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 dpdx = dFdx(-vViewPosition);
          vec3 dpdy = dFdy(-vViewPosition);
          float dhx = dFdx(dH);
          float dhy = dFdy(dH);
          vec3 r1 = cross(dpdy, normal);
          vec3 r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
          normal = normalize(abs(det) * normal - uDBump * dFade * grad);
        }`);
    };
    mat.customProgramCacheKey = () => `dc-detail-${scale}-${amt}-${bump}`;
    mat.needsUpdate = true;
  }

  // 본 건물 지붕: 방수층 이음선(1.5 m 간격), 가장자리 마감 띠(0.9 m), 빗물 얼룩, 배수구(9 m 칸마다 일부)를 셰이더로 그린다.
  // 지붕 면적(가운데와 반폭)은 _main에서 가져온다. 앞서 _addDetail이 붙인 셰이더가 있으면 그 뒤에 이어서 고친다.
  _roofDetail(mat) {
    const m = this._main;
    const uRoof = (this._roofU ??= { value: new THREE.Vector4(m.center.x, m.center.z, m.half.x - 0.8, m.half.z - 0.8) }); // 건물 상자는 모델을 읽은 뒤 정해지므로 그때 다시 맞춘다
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey?.() ?? '';
    mat.onBeforeCompile = (sh, r) => {
      prev?.(sh, r);
      sh.uniforms.uRoof = uRoof;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        varying vec3 vRp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRp = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vRp;
        uniform vec4 uRoof;
        float rh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rn(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rh(i), rh(i + vec2(1.0, 0.0)), f.x), mix(rh(i + vec2(0.0, 1.0)), rh(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        if (vRp.y > 1.0) {
          vec2 rp = vRp.xz;
          vec2 e = uRoof.zw - abs(rp - uRoof.xy);
          float ed = min(e.x, e.y);
          float trim = 1.0 - smoothstep(0.7, 0.95, ed);
          float f = fract(rp.x / 1.5);
          float seam = 1.0 - smoothstep(0.0, 0.07, min(f, 1.0 - f) * 1.5);
          float stain = rn(rp * 0.28) * 0.6 + rn(rp * 0.9) * 0.4;
          diffuseColor.rgb *= 1.0 - 0.22 * smoothstep(0.35, 0.8, stain);
          diffuseColor.rgb *= 1.0 - 0.34 * seam * (1.0 - trim);
          diffuseColor.rgb *= mix(1.0, 0.7, trim);
          diffuseColor.rgb *= 1.0 + 0.1 * smoothstep(0.93, 1.0, ed) * (1.0 - smoothstep(1.0, 1.08, ed)); // 마감 띠 안쪽의 밝은 선
          vec2 cell = floor(rp / 9.0);
          vec2 dc = (cell + 0.5 + (vec2(rh(cell + 1.7), rh(cell + 4.1)) - 0.5) * 0.4) * 9.0;
          float dd = distance(rp, dc);
          if (rh(cell) > 0.55 && ed > 2.0) {
            float grate = 1.0 - smoothstep(0.52, 0.58, dd);
            float ring = smoothstep(0.58, 0.62, dd) * (1.0 - smoothstep(0.78, 0.84, dd));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.18), grate);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.52, 0.54), ring * 0.8);
          }
        }`);
    };
    mat.customProgramCacheKey = () => `${prevKey}-dc-roof-v1`;
    mat.needsUpdate = true;
  }

  // 모델 노드(이름으로 찾음)의 월드 경계 상자를 m 단위로 모은다.
  _boxesOf(root, re) {
    root.updateMatrixWorld(true);
    const out = [];
    const box = new THREE.Box3();
    root.traverse((o) => {
      if (!re.test(o.name)) return;
      box.setFromObject(o);
      if (box.isEmpty()) return;
      out.push({ name: o.name, min: box.min.clone().multiplyScalar(CM), max: box.max.clone().multiplyScalar(CM) });
    });
    return out;
  }

  // 설비 보강(원본 모델은 그대로 두고 위에 얹는다):
  // - 냉각탑 위로 오르는 김: 냉각 전력이 클수록 많이, 빠르게(store.aggregates.cooling_power를 기준 32 kW로 나눈 값)
  // - 울타리 위 가시철사: 윗줄 두 가닥과 가시
  _buildEquipmentExtras(root) {
    const towers = this._boxesOf(root, /^CoolingTower_\d+$/);
    const fences = this._boxesOf(root, /^Fence_(East|North|South_East|South_West|West)$/);
    if (!towers.length && !fences.length) return null;
    const grp = new THREE.Group();
    grp.name = 'siteExtras';
    const tex = (this._glowTex ??= glowTexture());
    const rng = mulberry32(77);
    const PER = 36;
    if (towers.length) {
      const n = towers.length * PER;
      const base = new Float32Array(n * 3);
      const seed = new Float32Array(n * 2);
      towers.forEach((t, k) => {
        for (let i = 0; i < PER; i++) {
          const j = k * PER + i;
          base.set([(t.min.x + t.max.x) / 2 + (rng() - 0.5) * (t.max.x - t.min.x) * 0.5, t.max.y, (t.min.z + t.max.z) / 2 + (rng() - 0.5) * (t.max.z - t.min.z) * 0.5], j * 3);
          seed.set([rng(), 0.6 + rng() * 0.8], j * 2);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
      g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(n), 1)); // 입자마다 투명도
      g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(n).fill(4), 1)); // 입자마다 크기(m)
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, tint: { value: new THREE.Color(0.93, 0.95, 0.98) }, uScale: { value: 430 } },
        vertexShader: `attribute float aA; attribute float aS; varying float vA; uniform float uScale;
          void main() { vA = aA; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aS * uScale / max(-mv.z, 0.1); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform sampler2D map; uniform vec3 tint; varying float vA;
          void main() { float a = texture2D(map, gl_PointCoord).a * vA; if (a < 0.004) discard; gl_FragColor = vec4(tint, a); }`,
        transparent: true,
        depthWrite: false,
      });
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 4;
      pts.userData = { base, seed, per: PER, n };
      pts.name = 'plume';
      grp.add(pts);
    }
    if (fences.length) {
      const seg = [];
      for (const f of fences) {
        const alongX = f.max.x - f.min.x >= f.max.z - f.min.z;
        const len = alongX ? f.max.x - f.min.x : f.max.z - f.min.z;
        const c = alongX ? (f.min.z + f.max.z) / 2 : (f.min.x + f.max.x) / 2;
        const lo = alongX ? f.min.x : f.min.z;
        const top = f.max.y;
        const P = (s, y, off = 0) => (alongX ? [lo + s, y, c + off] : [c + off, y, lo + s]);
        for (const y of [top + 0.12, top + 0.34]) {
          seg.push(...P(0, y), ...P(len, y));
          for (let s = 0.3; s < len; s += 0.55) seg.push(...P(s, y - 0.05, 0.0), ...P(s + 0.1, y + 0.07, 0.04));
        }
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(seg);
      const mat = new LineMaterial({ color: 0x2f3236, linewidth: 1.4 * (this.pixelRatio ?? 1), worldUnits: false });
      const c = this.renderer.domElement;
      mat.resolution.set((c.clientWidth || 1) * (this.pixelRatio ?? 1), (c.clientHeight || 1) * (this.pixelRatio ?? 1));
      const lines = new LineSegments2(geo, mat);
      lines.frustumCulled = false;
      lines.name = 'fenceWire';
      this._wireMat = mat;
      grp.add(lines);
    }
    grp.userData = { towers: towers.length, fenceSegments: fences.length };
    return grp;
  }

  // 냉각탑 김 갱신(매 프레임). 냉각 전력(기준 32 kW)이 클수록 입자가 많이, 빠르게 오른다.
  _updatePlume(timeSec) {
    const pts = this._extras?.getObjectByName('plume');
    if (!pts) return;
    const { base, seed, per, n } = pts.userData;
    const cool = Number.isFinite(this.store.aggregates?.cooling_power) ? this.store.aggregates.cooling_power : 32;
    const level = Math.min(Math.max(cool / 32, 0.15), 1.6);
    this._plumeLevel = level;
    const active = Math.round(Math.min(per * level, per));
    const pos = pts.geometry.attributes.position;
    const aA = pts.geometry.attributes.aA;
    const aS = pts.geometry.attributes.aS;
    const wind = Math.sin(timeSec * 0.05) * 0.5 + 1.5;
    const night = this._nightU.value > 0.5;
    pts.material.uniforms.tint.value.setRGB(night ? 0.62 : 0.93, night ? 0.6 : 0.95, night ? 0.68 : 0.98); // 저녁에는 어둡게
    pts.material.uniforms.uScale.value = this.renderer.domElement.clientHeight * 0.5 || 430;
    for (let i = 0; i < n; i++) {
      const k = i % per;
      if (k >= active) { aA.setX(i, 0); continue; }
      const t = ((timeSec * 0.07 * level * seed[i * 2 + 1] + seed[i * 2]) % 1 + 1) % 1;
      pos.setXYZ(i, base[i * 3] + wind * t * 7 + Math.sin(t * 9 + i) * 0.6 * t, base[i * 3 + 1] + t * 9.5, base[i * 3 + 2] + t * 2.5);
      aA.setX(i, 0.6 * Math.min(t * 6, 1) * (1 - t)); // 아래에서 서서히 나타나 위로 갈수록 옅어진다
      aS.setX(i, 5 + 9 * t); // 올라가며 퍼진다
    }
    pos.needsUpdate = true;
    aA.needsUpdate = true;
    aS.needsUpdate = true;
    if (!this.reducedMotion) this._dirty = true;
  }

  // 부지 가로등 조명: root(glb 장면)에서 LightPole_* 노드의 월드 위치를 읽어 m 단위로 바꾼다.
  // wall: 데이터센터 건물 지붕의 모델 좌표 상자(없으면 null). 건물 둘레에 벽등을 일정한 간격으로 단다.
  _buildSiteLights(root, wall = null) {
    root.updateMatrixWorld(true);
    const poles = [];
    const box = new THREE.Box3();
    root.traverse((o) => {
      if (!/^LightPole_\d+$/.test(o.name)) return;
      box.setFromObject(o);
      if (box.isEmpty()) return;
      poles.push({ x: ((box.min.x + box.max.x) / 2) * CM, z: ((box.min.z + box.max.z) / 2) * CM, top: box.max.y * CM });
    });
    if (!poles.length) return null;
    const lamps = []; // 벽등: 건물 둘레 바닥 가까이, 바깥으로 0.5 m
    if (wall) {
      const gap = 9;
      const side = (x0, z0, x1, z1, nx, nz) => {
        const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / gap));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          lamps.push({ x: x0 + (x1 - x0) * t + nx * 0.5, z: z0 + (z1 - z0) * t + nz * 0.5 });
        }
      };
      side(wall.min.x, wall.min.z, wall.max.x, wall.min.z, 0, -1);
      side(wall.min.x, wall.max.z, wall.max.x, wall.max.z, 0, 1);
      side(wall.min.x, wall.min.z, wall.min.x, wall.max.z, -1, 0);
      side(wall.max.x, wall.min.z, wall.max.x, wall.max.z, 1, 0);
    }
    const tex = (this._glowTex ??= glowTexture());
    const warm = 0xffc880;
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, color: warm, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      poles.length + lamps.length,
    );
    const m = new THREE.Matrix4();
    const pts = new Float32Array((poles.length + lamps.length) * 3);
    poles.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, 0.09, p.z), new THREE.Quaternion(), new THREE.Vector3(15, 1, 15));
      pools.setMatrixAt(i, m);
      pts.set([p.x, p.top, p.z], i * 3);
    });
    lamps.forEach((p, k) => {
      const i = poles.length + k;
      m.compose(new THREE.Vector3(p.x, 0.08, p.z), new THREE.Quaternion(), new THREE.Vector3(5.5, 1, 5.5)); // 벽 아래를 비추는 작은 웅덩이
      pools.setMatrixAt(i, m);
      pts.set([p.x, 2.6, p.z], i * 3);
    });
    pools.frustumCulled = false;
    pools.renderOrder = 5;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const heads = new THREE.Points(g, new THREE.PointsMaterial({ map: tex, color: warm, size: 5, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    heads.frustumCulled = false;
    heads.renderOrder = 6;
    const grp = new THREE.Group();
    grp.name = 'siteLights';
    grp.userData.count = poles.length;
    grp.userData.wallLamps = lamps.length;
    grp.add(pools, heads);
    return grp;
  }

  // 부지 나무(줄기 + 수관) 인스턴스. spots: 모델 좌표의 [{ x, z, y0 }]
  _buildSiteTrees(spots) {
    const { trunk, crown } = siteTreeGeometries();
    const T = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ vertexColors: true }), spots.length);
    const C = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ vertexColors: true }), spots.length);
    const rng = mulberry32(41);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    spots.forEach((s, i) => {
      const k = 0.92 + rng() * 0.28;
      m.compose(new THREE.Vector3(s.x, s.y0, s.z), q.setFromAxisAngle(up, rng() * 6.28), new THREE.Vector3(k, k * (0.95 + rng() * 0.15), k));
      T.setMatrixAt(i, m);
      C.setMatrixAt(i, m);
      C.setColorAt(i, col.setRGB(0.9 + rng() * 0.2, 0.92 + rng() * 0.16, 0.9 + rng() * 0.2)); // 나무마다 색이 조금씩 다름
    });
    for (const o of [T, C]) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
    const g = new THREE.Group();
    g.name = 'siteTrees';
    g.add(T, C);
    return g;
  }

  // 주차장 아스팔트: 균열(능선 잡음), 기름 얼룩, 보수 흔적 사각형. 월드 좌표의 땅(y < 1) 면에만 그린다.
  _asphaltDetail(mat) {
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey?.() ?? '';
    mat.onBeforeCompile = (sh, r) => {
      prev?.(sh, r);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        varying vec3 vAp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAp = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vAp;
        float ah(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float an(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(ah(i), ah(i + vec2(1.0, 0.0)), f.x), mix(ah(i + vec2(0.0, 1.0)), ah(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec2 ap = vAp.xz;
          float fade = 1.0 - smoothstep(30.0, 110.0, distance(cameraPosition, vAp));
          float c1 = abs(an(ap * 0.22) - 0.5);
          float c2 = abs(an(ap * 0.61 + 7.0) - 0.5);
          float crack = clamp((1.0 - smoothstep(0.0, 0.012, c1)) * 0.9 + (1.0 - smoothstep(0.0, 0.008, c2)) * 0.5, 0.0, 1.0);
          float oil = smoothstep(0.62, 0.9, an(ap * 0.5 + 3.3)) * smoothstep(0.35, 0.6, an(ap * 0.13));
          vec2 pc = floor(ap / 14.0);
          vec2 pf = fract(ap / 14.0);
          float repair = step(0.8, ah(pc)) * step(0.15, pf.x) * step(pf.x, 0.75) * step(0.2, pf.y) * step(pf.y, 0.6);
          diffuseColor.rgb *= 1.0 - 0.5 * crack * fade;
          diffuseColor.rgb *= 1.0 - 0.38 * oil * fade;
          diffuseColor.rgb *= 1.0 - 0.14 * repair;
        }`);
    };
    mat.customProgramCacheKey = () => `${prevKey}-dc-asphalt-v1`;
    mat.needsUpdate = true;
  }

  // 장면의 모든 질감에 단계의 비등방성 필터링을 적용한다(기기가 허용하는 최대값 이하). 도로, 포장, 외벽을 비스듬히 볼 때 선명해진다.
  _applyAniso() {
    const n = Math.min(this.q.aniso ?? 4, this.renderer.capabilities.getMaxAnisotropy());
    const seen = new Set();
    this.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
        const t = m[k];
        if (t && !seen.has(t)) {
          seen.add(t);
          if (t.anisotropy !== n) {
            t.anisotropy = n;
          }
        }
      }
    });
  }

  // 그리는 배율을 화질 단계와 화면 크기로 정한다(일반 기준 FHD 화소 수 상한). 후처리 통로도 같은 크기로 맞춘다.
  _applySize(w, h) {
    const pr = pixelRatioFor(this.q, w, h, window.devicePixelRatio || 1);
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.fx?.setSize(w, h, pr);
    if (this._wireMat) {
      this._wireMat.resolution.set(w * pr, h * pr);
      this._wireMat.linewidth = 1.4 * pr;
    }
    if (this._bHover) {
      this._bHover.material.resolution.set(w * pr, h * pr);
      this._bHover.material.linewidth = 3 * pr;
    }
  }

  // 후처리(빛 번짐, 접촉 그림자). 단계가 켜고(q.bloom > 0), 주소의 fx=off가 아니며, 자동 시험 브라우저가 아니면(fx=on으로만) 켠다.
  _setupFx() {
    this.fx?.dispose();
    this.fx = null;
    const want = this.fxMode === 'on' || (this.fxMode !== 'off' && !navigator.webdriver);
    if (!want || !(this.q.bloom > 0)) return;
    const c = this.renderer.domElement;
    this.fx = new Fx(this.renderer, this.scene, this.camera, { bloom: this.q.bloom, ao: !!this.q.ao });
    this.fx.setSize(c.clientWidth || 1, c.clientHeight || 1, this.pixelRatio ?? 1);
    this._dirty = true;
  }

  _refreshSkyForFx() {
    if (this.sky && this.skyName) this.setSky(this.skyName);
  }

  resize(w, h) {
    this._applySize(w, h);
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
    this._alarmed = []; // 바닥 맥박 링을 그릴 장비: { x, z, r, rgb }
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
        const rc0 = this._rackCenter[i];
        this._alarmed.push({ x: rc0.x, z: rc0.z, r: 0.9, rgb: ALARM_COLOR[alarm] });
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
      if (alarm !== 'normal') {
        const cc = this._worldCenter(this.data.cracs[i]);
        this._alarmed.push({ x: cc.x, z: cc.z, r: 1.3, rgb: ALARM_COLOR[alarm] });
      }
    }
    for (const m of [this.rackFront, this.rackTop, this.rackHull, this.bar, this.cracFront]) m.instanceColor.needsUpdate = true;
    for (const m of [this.rackHull, this.barTrack, this.bar]) m.instanceMatrix.needsUpdate = true;
    this._blink = anyCritical && !this.reducedMotion;
  }

  // 이상이 있는 장비 키(심각한 것이 앞). 화면 위쪽 '다음 이상 장비 보기' 단추가 차례로 돈다.
  alarmedEquipment() {
    const rank = { critical: 0, warn: 1, normal: 2 };
    return [...this.rackKeys, ...this.cracKeys].map((k) => [k, this.store.worstAlarm(k)]).filter(([, a]) => a !== 'normal').sort((a, b) => rank[a[1]] - rank[b[1]]).map(([k]) => k);
  }

  // 이상 장비 바닥에 퍼지는 링(1.2초마다 한 번). 동작 줄이기에서는 퍼지지 않고 고정된 링만 보인다.
  _updateRings(timeSec) {
    const list = this._alarmed ?? [];
    if (!this._rings) {
      const geo = new THREE.RingGeometry(0.5, 0.58, 40).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this._rings = new THREE.InstancedMesh(geo, mat, this.rackKeys.length + this.cracKeys.length);
      this._rings.frustumCulled = false;
      this._rings.renderOrder = 4;
      this._rings.setColorAt(0, new THREE.Color(1, 1, 1));
      this.hall.add(this._rings);
    }
    const m = new THREE.Matrix4(), col = new THREE.Color(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const p = this.reducedMotion ? 0.4 : (timeSec / 1.2) % 1;
    const n = Math.min(list.length, this._rings.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const a = list[i];
      const s = a.r * (1 + 1.1 * p) * 2;
      pos.set(a.x, 0.05, a.z);
      sc.set(s, 1, s);
      this._rings.setMatrixAt(i, m.compose(pos, q, sc));
      const f = this.reducedMotion ? 0.8 : 1 - p;
      this._rings.setColorAt(i, col.setRGB(a.rgb[0] * f, a.rgb[1] * f, a.rgb[2] * f));
    }
    this._rings.count = n;
    this._rings.visible = n > 0 && this.stage === 'hall';
    this._rings.instanceMatrix.needsUpdate = true;
    if (this._rings.instanceColor) this._rings.instanceColor.needsUpdate = true;
    if (n > 0 && !this.reducedMotion) this._dirty = true; // 링이 움직이는 동안 계속 그린다
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
    this._keepOutside();
    this._keepOutOfCity();
    this._updateDepthRange();
    if (!this.cctv) this._updateShell();
    this._stepAirflow(dtSec, timeSec);
    if (this.stage === 'exterior') {
      this._updatePlume(timeSec);
      this.city?.update(this.reducedMotion ? 0 : dtSec);
      this.sky.material.uniforms.time.value = timeSec;
    }
    if (this._dirty || this.store.version !== this._lastVersion || this._blink) {
      this._paint(timeSec);
      this._updateRings(timeSec);
      this._lastVersion = this.store.version;
      this._dirty = false;
    }
    // 통로 이름은 서버실 화면에서 켜 둔 때만 보인다. 외관이나 CCTV에서는 어떤 경로로든 남지 않게 층 전체를 숨긴다.
    this.labelLayer.style.visibility = this.cctv || this.stage !== 'hall' || !this.showLabels ? 'hidden' : '';
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
    else if (this._split > 0 && this.stage === 'hall' && this._base && this.rackFront.visible) this._renderSplit();
    else if (this.fx && !this.cctv) this.fx.render();
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
