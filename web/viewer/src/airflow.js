// 공기 흐름 입자 (docs/22). 미리 계산한 속도장(flow.bin)에 입자를 띄워 흘린다.
// 시각화 목적이다: 질량 보존 퍼텐셜 흐름이라 점성, 난류, 부력이 없고 실제 CFD 결과가 아니다.
// 정상 가동 장과 CRAC 1대씩 멈춘 장을 겹쳐(근사) 켜진 CRAC 상태를 반영한다.
import * as THREE from 'three';

const CM = 0.01;
const COLD = [0.2, 0.6, 1.0];
const TAIL = 0.4; // 꼬리 길이(초). 흐름 방향이 보이도록 입자를 짧은 선으로 그린다
const MAX_VISUAL_SPEED = 2.2; // m/s. 급기구 가까이의 큰 값은 화면에서 잘라 낸다

export async function loadFlow(baseUrl) {
  const [meta, buf] = await Promise.all([
    fetch(`${baseUrl}data/flow.json`).then((r) => {
      if (!r.ok) throw new Error(`flow.json ${r.status}`);
      return r.json();
    }),
    fetch(`${baseUrl}data/flow.bin`).then((r) => {
      if (!r.ok) throw new Error(`flow.bin ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const [nx, ny, nz] = meta.shape;
  const cells = nx * ny * nz * 3;
  if (buf.byteLength !== cells * meta.fields.length) throw new Error('flow.bin 크기가 flow.json과 맞지 않는다');
  return { meta, data: new Int8Array(buf) };
}

export class Airflow {
  // flow: loadFlow 결과, data: scene.json, store: SensorStore, rackKeys/cracKeys: 장비 키 목록
  constructor(flow, data, store, rackKeys, cracKeys, { count = 7000, rng = Math.random } = {}) {
    this.meta = flow.meta;
    this.raw = flow.data;
    [this.nx, this.ny, this.nz] = flow.meta.shape;
    this.cell = flow.meta.cell_m;
    this.scale = flow.meta.vmax_ms / 127;
    this.data = data;
    this.store = store;
    this.rackKeys = rackKeys;
    this.cracKeys = cracKeys;
    this.rng = rng;
    this.count = count;
    this.nField = flow.meta.fields.length;
    this.fan = new Array(this.nField - 1).fill(1);
    this.u = new Float32Array(this.nx * this.ny * this.nz * 3);
    this._compose();
    this.rackId = new Int16Array(this.nx * this.ny * this.nz).fill(-1);
    data.racks.forEach((r, i) => this._mark(r, i));
    this.rackColor = rackKeys.map(() => [1, 0.5, 0.15]);
    this._lastColorAt = -1;

    this.pos = new Float32Array(count * 3); // 장면 좌표(m, z가 위)
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.heat = new Int16Array(count).fill(-1); // -1: 차가운 공기, 0 이상: 지나온 랙 번호
    this.geo = new THREE.BufferGeometry();
    this.vel = new Float32Array(count * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    this.points = new THREE.LineSegments(
      this.geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    for (let i = 0; i < count; i++) {
      this._spawn(i);
      this.age[i] = this.rng() * this.life[i]; // 처음부터 고르게 퍼지게
    }
    this._write();
  }

  _mark(box, id) {
    const i0 = Math.floor((box.min[0] * CM) / this.cell), i1 = Math.ceil((box.max[0] * CM) / this.cell);
    const j0 = Math.floor((box.min[1] * CM) / this.cell), j1 = Math.ceil((box.max[1] * CM) / this.cell);
    const k1 = Math.ceil((box.max[2] * CM) / this.cell);
    for (let i = Math.max(0, i0); i < Math.min(this.nx, i1); i++)
      for (let j = Math.max(0, j0); j < Math.min(this.ny, j1); j++)
        for (let k = 0; k < Math.min(this.nz, k1); k++) this.rackId[(i * this.ny + j) * this.nz + k] = id;
  }

  // 켜진 CRAC 비율(0~1) 목록. 값이 바뀐 때만 속도장을 다시 겹친다.
  setFans(fans) {
    const f = this.fan.map((_, i) => Math.min(1, Math.max(0, fans[i] ?? 1)));
    if (f.every((v, i) => Math.abs(v - this.fan[i]) < 0.01)) return false;
    this.fan = f;
    this._compose();
    return true;
  }

  // u = 정상 + Σ (1 - 팬 비율) x (그 CRAC이 멈춘 장 - 정상). 팬을 줄이면 그만큼만 반영하는 근사다.
  _compose() {
    const n = this.nx * this.ny * this.nz * 3;
    const w = this.fan.map((f) => 1 - f);
    const s = this.scale;
    for (let c = 0; c < n; c++) {
      const base = this.raw[c];
      let v = base;
      for (let m = 0; m < w.length; m++) if (w[m] > 0) v += w[m] * (this.raw[(m + 1) * n + c] - base);
      this.u[c] = v * s;
    }
  }

  // 한 지점의 속도(삼선형 보간). out에 m/s로 돌려주고 속력을 반환한다.
  sample(x, y, z, out) {
    const gx = Math.min(Math.max(x / this.cell - 0.5, 0), this.nx - 1.001);
    const gy = Math.min(Math.max(y / this.cell - 0.5, 0), this.ny - 1.001);
    const gz = Math.min(Math.max(z / this.cell - 0.5, 0), this.nz - 1.001);
    const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz);
    const fx = gx - i, fy = gy - j, fz = gz - k;
    out[0] = out[1] = out[2] = 0;
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++)
        for (let c = 0; c < 2; c++) {
          const wgt = (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (c ? fz : 1 - fz);
          const o = (((i + a) * this.ny + (j + b)) * this.nz + (k + c)) * 3;
          out[0] += wgt * this.u[o];
          out[1] += wgt * this.u[o + 1];
          out[2] += wgt * this.u[o + 2];
        }
    return Math.hypot(out[0], out[1], out[2]);
  }

  _spawn(p) {
    const vents = this.data.vents;
    const v = vents[Math.floor(this.rng() * vents.length)];
    const o = p * 3;
    this.pos[o] = (v.min[0] + this.rng() * (v.max[0] - v.min[0])) * CM;
    this.pos[o + 1] = (v.min[1] + this.rng() * (v.max[1] - v.min[1])) * CM;
    this.pos[o + 2] = 0.15 + this.rng() * 0.3;
    this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
    this.age[p] = 0;
    this.life[p] = 12 + this.rng() * 18;
    this.heat[p] = -1;
  }

  _refreshColors() {
    const view = this.store;
    this.rackKeys.forEach((k, i) => {
      const t = view.metric(k, 'temp_out')?.value;
      const f = t == null ? 0.3 : Math.min(1, Math.max(0, (t - 25) / 20)); // 25도 호박색 -> 45도 빨강
      this.rackColor[i] = [1, 0.75 - 0.55 * f, 0.2 - 0.12 * f];
    });
  }

  // dt초만큼 입자를 옮긴다. now는 색 갱신 주기에 쓴다.
  step(dt, now = 0) {
    dt = Math.min(dt, 0.1);
    if (now - this._lastColorAt > 0.5) {
      this._refreshColors();
      this._lastColorAt = now;
    }
    const u = [0, 0, 0];
    for (let p = 0; p < this.count; p++) {
      const o = p * 3;
      this.age[p] += dt;
      const sp = this.sample(this.pos[o], this.pos[o + 1], this.pos[o + 2], u);
      const k = sp > MAX_VISUAL_SPEED ? MAX_VISUAL_SPEED / sp : 1;
      this.vel[o] = u[0] * k;
      this.vel[o + 1] = u[1] * k;
      this.vel[o + 2] = u[2] * k;
      this.pos[o] += (u[0] * k + (this.rng() - 0.5) * 0.12) * dt;
      this.pos[o + 1] += (u[1] * k + (this.rng() - 0.5) * 0.12) * dt;
      this.pos[o + 2] += (u[2] * k + (this.rng() - 0.5) * 0.08) * dt;
      const gi = Math.floor(this.pos[o] / this.cell), gj = Math.floor(this.pos[o + 1] / this.cell), gk = Math.floor(this.pos[o + 2] / this.cell);
      const out = gi < 0 || gj < 0 || gk < 0 || gi >= this.nx || gj >= this.ny || gk >= this.nz;
      if (out || this.age[p] > this.life[p] || sp < 0.03) {
        this._spawn(p);
        continue;
      }
      const id = this.rackId[(gi * this.ny + gj) * this.nz + gk];
      if (id >= 0) this.heat[p] = id;
    }
    this._write();
  }

  _write() {
    const position = this.geo.attributes.position.array;
    const color = this.geo.attributes.color.array;
    for (let p = 0; p < this.count; p++) {
      const o = p * 3;
      const q = p * 6;
      // 장면(x, y, z) -> three(x, z, -y). 머리는 지금 위치, 꼬리는 속도 반대쪽
      position[q] = this.pos[o];
      position[q + 1] = this.pos[o + 2];
      position[q + 2] = -this.pos[o + 1];
      position[q + 3] = this.pos[o] - this.vel[o] * TAIL;
      position[q + 4] = this.pos[o + 2] - this.vel[o + 2] * TAIL;
      position[q + 5] = -(this.pos[o + 1] - this.vel[o + 1] * TAIL);
      const c = this.heat[p] >= 0 ? this.rackColor[this.heat[p]] : COLD;
      const fade = Math.min(1, this.age[p] / 0.6, (this.life[p] - this.age[p]) / 1.5);
      color[q] = c[0] * fade;
      color[q + 1] = c[1] * fade;
      color[q + 2] = c[2] * fade;
      color[q + 3] = color[q + 4] = color[q + 5] = 0; // 꼬리 끝은 투명하게(가산 혼합이라 검정 = 안 보임)
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.points.material.dispose();
  }
}
