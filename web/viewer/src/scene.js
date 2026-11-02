// Three.js 장면 (docs/18 5.1, 5.3장). 랙은 InstancedMesh 묶음으로 그리고 값은 인스턴스 색으로 칠한다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ALARM_COLOR, barFraction, confidenceColor, sampleColor } from './colors.js';

// 보는 값. 범위는 화면 색 곡선 기준이다(입구 온도는 Unreal과 같은 18~35도).
export const VIEWS = {
  temp_in: { label: '입구 온도', metric: 'temp_in', cold: 18, hot: 35, unit: '°C', digits: 1 },
  temp_out: { label: '배기 온도', metric: 'temp_out', cold: 20, hot: 50, unit: '°C', digits: 1 },
  power: { label: '전력', metric: 'power', cold: 0, hot: 15, unit: 'kW', digits: 1 },
};

const CM = 0.01;
// 장면 좌표(cm, Z가 위) -> three.js 좌표(m, Y가 위). 손 방향이 바뀌지 않게 y는 부호를 뒤집는다.
const toThree = (x, y, z) => new THREE.Vector3(x * CM, z * CM, -y * CM);
const keyOf = (name) => name.toLowerCase(); // Rack_01 -> rack_01

const BODY = new THREE.Color(0x2b313b);
const CRAC_BODY = new THREE.Color(0x30404f);
const CRAC_OK = [0.08, 0.4, 0.55];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class HallScene {
  constructor(canvas, labelLayer, data, store, { reducedMotion = false, stage = 'hall' } = {}) {
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1218);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !reducedMotion;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 45;

    const [sx, sy, sz] = data.size;
    this.center = toThree(sx / 2, sy / 2, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 14, 8);
    this.scene.add(sun);

    this.hall = new THREE.Group();
    this.scene.add(this.hall);
    this._buildStatic(data, sx, sy, sz);
    this._buildRacks(data);
    this._buildCracs(data);
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
    const grid = new THREE.GridHelper(Math.max(sx, sy) * CM, Math.round(Math.max(sx, sy) / 100), 0x2c333f, 0x232933);
    grid.position.copy(this.center);
    this.hall.add(grid);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx * CM, sz * CM, sy * CM)), new THREE.LineBasicMaterial({ color: 0x3a4352 }));
    outline.position.set(this.center.x, (sz * CM) / 2, this.center.z);
    this.hall.add(outline);

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
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W * 4, D * 4), mat(0x1a2028, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(c.x, -0.02, c.z);
    g.add(ground);
    this.building = [];
    this.building.push(add(W, H, D, c.x, H / 2, c.z, mat(0x8a93a1)));
    this.building.push(add(W + 0.8, 0.5, D + 0.8, c.x, H + 0.25, c.z, mat(0x4a5361)));
    this.building.push(add(W + 0.02, 1.0, D + 0.02, c.x, H * 0.55, c.z, mat(0x1d3a52, { roughness: 0.3, metalness: 0.4 }))); // 창 띠
    this.building.push(add(3.2, 3.4, 0.5, c.x, 1.7, c.z + D / 2 + 0.2, mat(0x2f6f9f))); // 출입구
    for (let i = -1; i <= 1; i++) this.building.push(add(2.4, 1.4, 2.4, c.x + i * (W / 4), H + 1.2, c.z - D / 4, mat(0x5b6675))); // 지붕 설비
    this.beacon = add(1.0, 1.0, 1.0, c.x, H + 1.5, c.z + D / 4, new THREE.MeshBasicMaterial({ color: 0x19cc4d }));
    this.building.push(this.beacon);
    this._extR = Math.max(W, D);
    this._extH = H;
    g.visible = false;
    this.exterior = g;
    this.scene.add(g);
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
    this.controls.maxDistance = ext ? this._extR * 3 : 45;
    this.controls.maxPolarAngle = Math.PI * (ext ? 0.48 : 0.49);
  }

  // 외관과 홀을 바꾼다. 카메라는 0.8초 동안 옮기고(동작 줄이기면 바로), 이동 중에는 거리 제한을 풀어 둔다.
  setStage(stage, instant = false) {
    if (stage !== 'exterior' && stage !== 'hall') return;
    this.stage = stage;
    const ext = stage === 'exterior';
    this.hall.visible = !ext;
    this.exterior.visible = ext;
    this.hover(null);
    for (const l of this.labels) l.el.hidden = ext || !this.showLabels;
    const moving = !(instant || this.reducedMotion);
    if (moving) {
      this.controls.minDistance = 2;
      this.controls.maxDistance = this._extR * 3;
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
      presets.ext = { pos: new THREE.Vector3(c.x + r * 1.1, r * 0.62, c.z + r * 1.4), target: new THREE.Vector3(c.x, this._extH / 2, c.z) };
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
    if (this.beacon) this.beacon.material.color.setRGB(...(worst === 'normal' ? [0.1, 0.8, 0.3] : ALARM_COLOR[worst]));
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
    if (this._dirty || this.store.version !== this._lastVersion || this._blink) {
      this._paint(timeSec);
      this._lastVersion = this.store.version;
      this._dirty = false;
    }
    if (this.showLabels && this.stage === 'hall') {
      const r = this.renderer.domElement.getBoundingClientRect();
      for (const l of this.labels) {
        const v = l.pos.clone().project(this.camera);
        const hide = v.z > 1;
        l.el.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px) translate(-50%, -50%)`;
        l.el.style.visibility = hide ? 'hidden' : 'visible';
      }
    }
    this.renderer.render(this.scene, this.camera);
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
