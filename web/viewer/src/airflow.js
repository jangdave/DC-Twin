// 공기 흐름 입자 (docs/22). 미리 계산한 속도장(flow.bin)에 입자를 띄워 흘린다.
// 시각화 목적이다: 질량 보존 퍼텐셜 흐름이라 점성, 난류, 부력이 없고 실제 CFD 결과가 아니다.
// 정상 가동 장과 CRAC 1대씩 멈춘 장을 겹쳐(근사) 켜진 CRAC 상태를 반영한다.
import * as THREE from 'three';
import { sampleColor } from './colors.js';

const CM = 0.01;
const COLD = [0.2, 0.6, 1.0];
const TAIL = 0.4; // 꼬리 길이(초). 흐름 방향이 보이도록 입자를 짧은 선으로 그린다
// 꼬리는 지나온 위치를 이은 꺾은선(마디 SEG개)이다. 예전에는 "지금 위치 - 속도 x TAIL" 직선 하나라서 흐름이 꺾이는 곳(바닥 아래 -> 타일)에서
// 막대 전체가 머리를 축으로 돌아 보였다(2026-11-16 사용자 지적: "직선이 휘어지는 느낌"). 지나온 길을 그리면 꺾이는 곳이 곡선으로 보인다.
export const SEG = 3;
const HIST_DT = TAIL / SEG; // 지나온 위치를 기억하는 간격(초)
const MAX_VISUAL_SPEED = 2.2; // m/s. 급기구 가까이의 큰 값은 화면에서 잘라 낸다
// 시각화 가정(실측 아님): 냉기 통로 급기의 일부는 랙 틈, 랙 위, 통로 끝으로 새어 랙을 거치지 않고 위로 오른다.
// 퍼텐셜 흐름은 질량이 모두 랙을 지나므로 그대로 두면 새는 공기가 하나도 없어 비현실적이다. 새는 입자는 속도장 대신 천천히 떠오른다.
export const LEAK_FRACTION = 0.1;
export const PLENUM_SPAWN = 0.3; // 이중 바닥일 때 바닥 아래(공조기 밑)에서 출발하는 입자 비율
const LEAK_CEILING = 3.6; // m. 이 높이를 넘으면 사라진다(천장 근처에서 되돌아가는 공기에 섞인다고 본다)
const LEAK_WARM = [1.0, 0.72, 0.38]; // 올라가며 뜨거운 공기와 섞여 따뜻해지는 색

export async function loadFlow(baseUrl, name = 'flow') {
  const [meta, buf] = await Promise.all([
    fetch(`${baseUrl}data/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`${name}.json ${r.status}`);
      return r.json();
    }),
    fetch(`${baseUrl}data/${name}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${name}.bin ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const [nx, ny, nz] = meta.shape;
  const cells = nx * ny * nz * 3;
  if (buf.byteLength !== cells * meta.fields.length) throw new Error('flow.bin 크기가 flow.json과 맞지 않는다');
  return { meta, data: new Int8Array(buf) };
}

// 서버 작업이 보낸 흐름(job_flow, sim/sensors/dct_sensors/web_flow.py)을 loadFlow와 같은 모양으로 바꾼다.
// encoding "sequence": 장마다 그 작업의 팬 상태 하나의 흐름 값(차이가 아님)이고, data_b64에 int8로 들어 있다.
export function flowFromJob(obj) {
  const meta = { ...obj };
  delete meta.data_b64;
  if (meta.encoding !== 'sequence' || !Array.isArray(meta.fields) || !meta.fields.length) throw new Error('작업 흐름 형식이 아니다');
  const bin = atob(String(obj.data_b64 ?? ''));
  const data = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = (bin.charCodeAt(i) << 24) >> 24;
  const [nx, ny, nz] = meta.shape;
  if (data.length !== nx * ny * nz * 3 * meta.fields.length) throw new Error('작업 흐름 크기가 shape와 맞지 않는다');
  return { meta, data };
}

export class Airflow {
  // flow: loadFlow 결과, data: scene.json, store: SensorStore, rackKeys/cracKeys: 장비 키 목록
  constructor(flow, data, store, rackKeys, cracKeys, { count = 7000, rng = Math.random } = {}) {
    this.meta = flow.meta;
    this.raw = flow.data;
    [this.nx, this.ny, this.nz] = flow.meta.shape;
    this.cell = flow.meta.cell_m;
    // 이중 바닥(docs/33): 격자가 바닥 아래 공간까지 내려가면 격자 z=0이 장면 z = z0(음수, m)다
    this.z0 = flow.meta.z0_m ?? 0;
    this.plenum = flow.meta.plenum ?? null;
    this.scale = flow.meta.vmax_ms / 127;
    this.data = data;
    this.store = store;
    this.rackKeys = rackKeys;
    this.cracKeys = cracKeys;
    this.rng = rng;
    this.count = count;
    this.active = count; // 계산하고 그리는 입자 수. 화질을 낮추면 줄어든다
    this.nField = flow.meta.fields.length;
    this.diff = flow.meta.encoding === 'diff';
    // 작업 흐름(sequence): 장마다 팬 상태가 있고, 지금 팬 값과 가장 가까운 장을 그대로 쓴다(겹치지 않는다)
    this.seq = flow.meta.encoding === 'sequence';
    this.seqFans = this.seq ? flow.meta.fields.map((f) => cracKeys.map((k) => f.fan?.[k] ?? 1)) : null;
    this.field = 0;
    this.fan = this.seq ? this.seqFans[0].slice() : new Array(this.nField - 1).fill(1);
    this.u = new Float32Array(this.nx * this.ny * this.nz * 3);
    this._compose();
    this.rackId = new Int16Array(this.nx * this.ny * this.nz).fill(-1);
    data.racks.forEach((r, i) => this._mark(r, i));
    this.rackColor = rackKeys.map(() => [1, 0.5, 0.15]);
    this.coldColor = rackKeys.map(() => COLD); // 가까운 랙의 입구 온도 색(차가운 공기)
    this._mix = [0, 0, 0];
    this.nearRack = this._nearestRacks(data.racks);
    this._lastColorAt = -1;

    this.pos = new Float32Array(count * 3); // 장면 좌표(m, z가 위)
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.heat = new Int16Array(count).fill(-1); // -1: 차가운 공기, 0 이상: 지나온 랙 번호
    // 새는 입자 비율(0~1). 흐름장이 OpenFOAM이면(flow.json source) 격벽 위로 새고 도는 공기가 흐름장에 이미 들어 있어 흉내 입자를 쓰지 않는다
    this.leak = flow.meta.source === 'openfoam' ? 0 : LEAK_FRACTION;
    this.mode = new Uint8Array(count); // 0: 속도장을 따름, 1: 새는 공기(위로 떠오름)
    this.geo = new THREE.BufferGeometry();
    this.vel = new Float32Array(count * 3);
    this.hist = new Float32Array(count * SEG * 3); // 지나온 위치(가까운 것부터), 장면 좌표
    this.histAt = new Float32Array(count); // 마지막으로 기억한 뒤 지난 시간(초)
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * SEG * 6), 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * SEG * 6), 3));
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

  // 위에서 본 칸마다 가까운 랙 K대와 가중치(거리 역수 제곱). 차가운 공기를 그 랙들의 입구 온도 색 평균으로 칠할 때 쓴다.
  _nearestRacks(racks) {
    const K = 4;
    this.K = K;
    const idx = new Int16Array(this.nx * this.ny * K);
    const wgt = new Float32Array(this.nx * this.ny * K);
    const cx = racks.map((r) => ((r.min[0] + r.max[0]) / 2) * CM);
    const cy = racks.map((r) => ((r.min[1] + r.max[1]) / 2) * CM);
    const d = new Float64Array(cx.length);
    for (let i = 0; i < this.nx; i++)
      for (let j = 0; j < this.ny; j++) {
        const x = (i + 0.5) * this.cell, y = (j + 0.5) * this.cell;
        for (let r = 0; r < cx.length; r++) d[r] = (cx[r] - x) ** 2 + (cy[r] - y) ** 2;
        const order = [...d.keys()].sort((a, b) => d[a] - d[b]).slice(0, K);
        let sum = 0;
        order.forEach((r, n) => {
          const w = 1 / (d[r] + 0.25);
          idx[(i * this.ny + j) * K + n] = r;
          wgt[(i * this.ny + j) * K + n] = w;
          sum += w;
        });
        for (let n = 0; n < K; n++) wgt[(i * this.ny + j) * K + n] /= sum;
      }
    this.nearW = wgt;
    return idx;
  }

  _mark(box, id) {
    const i0 = Math.floor((box.min[0] * CM) / this.cell), i1 = Math.ceil((box.max[0] * CM) / this.cell);
    const j0 = Math.floor((box.min[1] * CM) / this.cell), j1 = Math.ceil((box.max[1] * CM) / this.cell);
    const k0 = Math.floor((box.min[2] * CM - this.z0) / this.cell), k1 = Math.ceil((box.max[2] * CM - this.z0) / this.cell);
    for (let i = Math.max(0, i0); i < Math.min(this.nx, i1); i++)
      for (let j = Math.max(0, j0); j < Math.min(this.ny, j1); j++)
        for (let k = Math.max(0, k0); k < Math.min(this.nz, k1); k++) this.rackId[(i * this.ny + j) * this.nz + k] = id;
  }

  // 켜진 CRAC 비율(0~1) 목록. 값이 바뀐 때만 속도장을 다시 겹친다.
  setFans(fans) {
    const f = this.fan.map((_, i) => Math.min(1, Math.max(0, fans[i] ?? 1)));
    if (f.every((v, i) => Math.abs(v - this.fan[i]) < 0.01)) return false;
    this.fan = f;
    if (this.seq) {
      const d = this.seqFans.map((g) => g.reduce((acc, v, i) => acc + (v - f[i]) ** 2, 0));
      const best = d.indexOf(Math.min(...d));
      if (best === this.field) return false;
      this.field = best;
    }
    this._compose();
    return true;
  }

  // u = 정상 + Σ (1 - 팬 비율) x (그 CRAC이 멈춘 장 - 정상). 팬을 줄이면 그만큼만 반영하는 근사다.
  _compose() {
    const n = this.nx * this.ny * this.nz * 3;
    const w = this.fan.map((f) => 1 - f);
    const s = this.scale;
    if (this.seq) {
      const o = this.field * n;
      for (let c = 0; c < n; c++) this.u[c] = this.raw[o + c] * s;
      return;
    }
    for (let c = 0; c < n; c++) {
      const base = this.raw[c];
      let v = base;
      // encoding diff(2026-11-11): 둘째 장부터 정상과의 차이가 저장되어 있다. 아니면 각 장의 값이라 정상을 뺀다
      if (this.diff) for (let m = 0; m < w.length; m++) { if (w[m] > 0) v += w[m] * this.raw[(m + 1) * n + c]; }
      else for (let m = 0; m < w.length; m++) if (w[m] > 0) v += w[m] * (this.raw[(m + 1) * n + c] - base);
      this.u[c] = v * s;
    }
  }

  // 한 지점의 속도(삼선형 보간). out에 m/s로 돌려주고 속력을 반환한다.
  sample(x, y, z, out) {
    const gx = Math.min(Math.max(x / this.cell - 0.5, 0), this.nx - 1.001);
    const gy = Math.min(Math.max(y / this.cell - 0.5, 0), this.ny - 1.001);
    const gz = Math.min(Math.max((z - this.z0) / this.cell - 0.5, 0), this.nz - 1.001);
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
    const o = p * 3;
    if (this.plenum && this.rng() < PLENUM_SPAWN) {
      // 이중 바닥: 일부는 공조기 아래 바닥 아래 공간에서 출발한다(공조기가 아래로 불어 넣는 찬 공기). 타일로 올라와 방으로 나간다
      const c = this.data.cracs[Math.floor(this.rng() * this.data.cracs.length)];
      const floorTop = -this.plenum.floor_cm * CM;
      this.pos[o] = (c.min[0] + this.rng() * (c.max[0] - c.min[0])) * CM;
      this.pos[o + 1] = (c.min[1] + this.rng() * (c.max[1] - c.min[1])) * CM;
      this.pos[o + 2] = floorTop - 0.05 - this.rng() * 0.15;
    } else {
      const vents = this.data.vents;
      const v = vents[Math.floor(this.rng() * vents.length)];
      this.pos[o] = (v.min[0] + this.rng() * (v.max[0] - v.min[0])) * CM;
      this.pos[o + 1] = (v.min[1] + this.rng() * (v.max[1] - v.min[1])) * CM;
      this.pos[o + 2] = 0.15 + this.rng() * 0.3;
    }
    this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
    for (let h = 0; h < SEG; h++) this.hist.set(this.pos.subarray(o, o + 3), (p * SEG + h) * 3);
    this.histAt[p] = 0;
    this.age[p] = 0;
    this.heat[p] = -1;
    this.mode[p] = this.rng() < this.leak ? 1 : 0;
    this.life[p] = this.mode[p] ? 6 + this.rng() * 5 : 12 + this.rng() * 18;
  }

  _refreshColors() {
    const view = this.store;
    this.rackKeys.forEach((k, i) => {
      const t = view.metric(k, 'temp_out')?.value;
      const f = t == null ? 0.3 : Math.min(1, Math.max(0, (t - 25) / 20)); // 25도 호박색 -> 45도 빨강
      this.rackColor[i] = [1, 0.75 - 0.55 * f, 0.2 - 0.12 * f];
      const tin = view.metric(k, 'temp_in');
      if (tin?.value != null) {
        const [r, g, b] = sampleColor(tin, 18, 35); // 입구 온도 색(18도 파랑 -> 35도 빨강)을 밝게
        this.coldColor[i] = [r * 0.7 + 0.3, g * 0.7 + 0.3, b * 0.7 + 0.3];
      }
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
    for (let p = 0; p < this.active; p++) {
      const o = p * 3;
      this.age[p] += dt;
      this.histAt[p] += dt;
      if (this.histAt[p] >= HIST_DT) {
        // 지나온 위치를 한 칸씩 밀고 지금 위치를 가장 가까운 자리에 넣는다
        const b = p * SEG * 3;
        this.hist.copyWithin(b + 3, b, b + (SEG - 1) * 3);
        this.hist[b] = this.pos[o];
        this.hist[b + 1] = this.pos[o + 1];
        this.hist[b + 2] = this.pos[o + 2];
        this.histAt[p] = 0;
      }
      if (this.mode[p] === 1) {
        // 새는 공기: 속도장을 쓰지 않고 위로 0.5~0.9 m/s로 떠오르며 옆으로 조금 흔들린다
        const vz = 0.5 + 0.4 * this.rng();
        this.vel[o] = (this.rng() - 0.5) * 0.3;
        this.vel[o + 1] = (this.rng() - 0.5) * 0.3;
        this.vel[o + 2] = vz;
        this.pos[o] += this.vel[o] * dt;
        this.pos[o + 1] += this.vel[o + 1] * dt;
        this.pos[o + 2] += vz * dt;
        if (this.pos[o + 2] > LEAK_CEILING || this.age[p] > this.life[p]) this._spawn(p);
        continue;
      }
      const sp = this.sample(this.pos[o], this.pos[o + 1], this.pos[o + 2], u);
      const k = sp > MAX_VISUAL_SPEED ? MAX_VISUAL_SPEED / sp : 1;
      this.vel[o] = u[0] * k;
      this.vel[o + 1] = u[1] * k;
      this.vel[o + 2] = u[2] * k;
      this.pos[o] += (u[0] * k + (this.rng() - 0.5) * 0.12) * dt;
      this.pos[o + 1] += (u[1] * k + (this.rng() - 0.5) * 0.12) * dt;
      this.pos[o + 2] += (u[2] * k + (this.rng() - 0.5) * 0.08) * dt;
      const gi = Math.floor(this.pos[o] / this.cell), gj = Math.floor(this.pos[o + 1] / this.cell), gk = Math.floor((this.pos[o + 2] - this.z0) / this.cell);
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
    for (let p = 0; p < this.active; p++) {
      const o = p * 3;
      const q = p * SEG * 6;
      // 장면(x, y, z) -> three(x, z, -y). 머리는 지금 위치, 마디는 지나온 위치(가까운 것부터)
      const hb = p * SEG * 3;
      let ax = this.pos[o], ay = this.pos[o + 1], az = this.pos[o + 2];
      for (let h = 0; h < SEG; h++) {
        const bx = this.hist[hb + h * 3], by = this.hist[hb + h * 3 + 1], bz = this.hist[hb + h * 3 + 2];
        const w = q + h * 6;
        position[w] = ax;
        position[w + 1] = az;
        position[w + 2] = -ay;
        position[w + 3] = bx;
        position[w + 4] = bz;
        position[w + 5] = -by;
        ax = bx; ay = by; az = bz;
      }
      let c;
      if (this.heat[p] >= 0) c = this.rackColor[this.heat[p]];
      else {
        const gi = Math.min(this.nx - 1, Math.max(0, Math.floor(this.pos[o] / this.cell)));
        const gj = Math.min(this.ny - 1, Math.max(0, Math.floor(this.pos[o + 1] / this.cell)));
        const b = (gi * this.ny + gj) * this.K;
        c = this._mix;
        c[0] = c[1] = c[2] = 0;
        for (let n = 0; n < this.K; n++) {
          const k = this.coldColor[this.nearRack[b + n]];
          const w = this.nearW[b + n];
          c[0] += w * k[0];
          c[1] += w * k[1];
          c[2] += w * k[2];
        }
      }
      if (this.mode[p] === 1) {
        const t = Math.min(Math.max((this.pos[o + 2] - 0.4) / 3, 0), 1) * 0.85; // 높이 올라갈수록 따뜻한 색
        c = [c[0] + (LEAK_WARM[0] - c[0]) * t, c[1] + (LEAK_WARM[1] - c[1]) * t, c[2] + (LEAK_WARM[2] - c[2]) * t];
      }
      const fade = Math.min(1, this.age[p] / 0.6, (this.life[p] - this.age[p]) / 1.5);
      // 마디마다 머리 쪽이 밝고 꼬리 끝으로 갈수록 어두워진다(가산 혼합이라 검정 = 안 보임)
      for (let h = 0; h < SEG; h++) {
        const w = q + h * 6;
        const f0 = fade * (1 - h / SEG), f1 = fade * (1 - (h + 1) / SEG);
        color[w] = c[0] * f0;
        color[w + 1] = c[1] * f0;
        color[w + 2] = c[2] * f0;
        color[w + 3] = c[0] * f1;
        color[w + 4] = c[1] * f1;
        color[w + 5] = c[2] * f1;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  setActive(n) {
    this.active = Math.min(this.count, n);
    this.geo.setDrawRange(0, this.active * SEG * 2);
  }

  dispose() {
    this.geo.dispose();
    this.points.material.dispose();
  }
}
