// 도심에 쓰는 그림(캔버스로 직접 그린다). 외부 이미지를 쓰지 않는다 (docs/26).
// 모든 그림은 오른쪽 아래 구석에 흰 점이 있어, 지붕처럼 무늬가 없는 면은 그 점을 가리키게 한다.
import * as THREE from 'three';

// 그림 한 장이 덮는 실제 크기(m)와 가로 창 수. 건물 크기에 맞춰 반복 횟수를 정할 때 쓴다.
export const FACADE_TILE = {
  glass: { tw: 12.8, th: 15.2, cols: 4 },
  ribbon: { tw: 16, th: 14.4, cols: 4 },
  concrete: { tw: 12, th: 14.4, cols: 4 },
  brick: { tw: 12.8, th: 12, cols: 4 },
  metal: { tw: 12.8, th: 14.4, cols: 4 },
};
export const ROOF_UV = 0.985; // 흰 점의 위치

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const S = 256;
const canvas = (w = S, h = S) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

function speckle(g, rng, n, alpha, w = S, h = S) {
  for (let i = 0; i < n; i++) {
    const v = rng() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rng()})`;
    g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
}

function finish(wall, glow, rng) {
  const g = wall.getContext('2d');
  speckle(g, rng, 900, 0.07);
  g.fillStyle = '#fff';
  g.fillRect(S - 8, S - 8, 8, 8); // 지붕용 흰 점
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: tex(wall, true), glow: tex(glow, true) };
}

const GLASS = ['#2b5a78', '#3a7392', '#1f4560', '#4b86a3', '#335f7a'];

function drawGlass(rng) {
  const wall = canvas(), glow = canvas();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#1a2a36';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64, y = r * 64;
      const col = GLASS[Math.floor(rng() * GLASS.length)];
      const grad = a.createLinearGradient(x, y, x + 64, y + 64);
      grad.addColorStop(0, col);
      grad.addColorStop(1, '#16303f');
      a.fillStyle = grad;
      a.fillRect(x + 2, y + 2, 60, 60);
      a.fillStyle = 'rgba(255,255,255,0.10)'; // 하늘이 비치는 줄
      a.beginPath();
      a.moveTo(x + 2, y + 40);
      a.lineTo(x + 40, y + 2);
      a.lineTo(x + 62, y + 2);
      a.lineTo(x + 2, y + 62);
      a.fill();
      if (rng() < 0.3) {
        a.fillStyle = 'rgba(243,217,160,0.85)';
        a.fillRect(x + 2, y + 2, 60, 60);
        g.fillStyle = '#ffd28a';
        g.fillRect(x + 2, y + 2, 60, 60);
      }
    }
  }
  return finish(wall, glow, rng);
}

function drawRibbon(rng) {
  const wall = canvas(), glow = canvas();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#a4a8ac';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let r = 0; r < 4; r++) {
    const y = r * 64 + 18;
    const grad = a.createLinearGradient(0, y, 0, y + 40);
    grad.addColorStop(0, '#3c5870');
    grad.addColorStop(1, '#22344a');
    a.fillStyle = grad;
    a.fillRect(0, y, S, 40);
    a.fillStyle = '#6d7378'; // 창 위 아래 얇은 선
    a.fillRect(0, y - 2, S, 2);
    a.fillRect(0, y + 40, S, 2);
    for (let c = 0; c < 8; c++) {
      a.fillStyle = '#6d7378';
      a.fillRect(c * 32, y, 2, 40);
      if (rng() < 0.28) {
        a.fillStyle = 'rgba(243,217,160,0.85)';
        a.fillRect(c * 32 + 2, y, 30, 40);
        g.fillStyle = '#ffd28a';
        g.fillRect(c * 32 + 2, y, 30, 40);
      }
    }
  }
  return finish(wall, glow, rng);
}

function drawConcrete(rng) {
  const wall = canvas(), glow = canvas();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#a09a92';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64 + 14, y = r * 64 + 12;
      a.fillStyle = '#7f7a73';
      a.fillRect(x - 2, y - 2, 40, 44);
      a.fillStyle = '#2a3340';
      a.fillRect(x, y, 36, 40);
      if (rng() < 0.32) {
        a.fillStyle = 'rgba(243,217,160,0.9)';
        a.fillRect(x, y, 36, 40);
        g.fillStyle = '#ffd28a';
        g.fillRect(x, y, 36, 40);
      }
    }
    a.fillStyle = '#7a756e'; // 층 사이 띠
    a.fillRect(0, r * 64 + 60, S, 4);
  }
  return finish(wall, glow, rng);
}

function drawBrick(rng) {
  const wall = canvas(), glow = canvas();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#8a4a3a';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 8) {
    a.fillStyle = '#6f3a2d';
    a.fillRect(0, y, S, 1);
    for (let x = (y / 8) % 2 ? 0 : 8; x < S; x += 16) a.fillRect(x, y, 1, 8);
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64 + 16, y = r * 64 + 14;
      a.fillStyle = '#d9d2c0';
      a.fillRect(x - 3, y - 3, 38, 42);
      a.fillStyle = '#2c3a4a';
      a.fillRect(x, y, 32, 36);
      a.fillStyle = '#d9d2c0';
      a.fillRect(x + 15, y, 2, 36);
      if (rng() < 0.3) {
        a.fillStyle = 'rgba(243,217,160,0.9)';
        a.fillRect(x, y, 15, 36);
        g.fillStyle = '#ffd28a';
        g.fillRect(x, y, 15, 36);
      }
    }
  }
  return finish(wall, glow, rng);
}

function drawMetal(rng) {
  const wall = canvas(), glow = canvas();
  const a = wall.getContext('2d'), g = glow.getContext('2d');
  a.fillStyle = '#b9bec4';
  a.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 16) {
    a.fillStyle = x % 32 ? '#aab0b7' : '#c8cdd2';
    a.fillRect(x, 0, 8, S);
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64 + 8, y = r * 64 + 20;
      a.fillStyle = '#2b3744';
      a.fillRect(x, y, 48, 22);
      if (rng() < 0.3) {
        a.fillStyle = 'rgba(243,217,160,0.9)';
        a.fillRect(x, y, 48, 22);
        g.fillStyle = '#ffd28a';
        g.fillRect(x, y, 48, 22);
      }
    }
  }
  return finish(wall, glow, rng);
}

export function facadeTextures(seed = 5) {
  const rng = mulberry32(seed);
  return { glass: drawGlass(rng), ribbon: drawRibbon(rng), concrete: drawConcrete(rng), brick: drawBrick(rng), metal: drawMetal(rng) };
}

function repeatTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function roadTexture() {
  const c = canvas(64, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#3b3d41';
  x.fillRect(0, 0, 64, 128);
  const rng = mulberry32(9);
  speckle(x, rng, 900, 0.12, 64, 128);
  x.fillStyle = '#d9c25a';
  x.fillRect(30, 8, 4, 48);
  x.fillStyle = '#c9ccd0';
  x.fillRect(3, 0, 2, 128);
  x.fillRect(59, 0, 2, 128);
  return repeatTex(c);
}

// 인도: 가로세로 2 m 판 4 x 4장(8 m)
export function sidewalkTexture() {
  const c = canvas(128, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#9a9c9e';
  x.fillRect(0, 0, 128, 128);
  const rng = mulberry32(21);
  speckle(x, rng, 600, 0.1, 128, 128);
  x.fillStyle = '#7d8083';
  for (let i = 0; i < 128; i += 32) {
    x.fillRect(i, 0, 1, 128);
    x.fillRect(0, i, 128, 1);
  }
  return repeatTex(c);
}

export function grassTexture() {
  const c = canvas(128, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#3f6b34';
  x.fillRect(0, 0, 128, 128);
  const rng = mulberry32(31);
  for (let i = 0; i < 1400; i++) {
    const l = 30 + rng() * 25;
    x.fillStyle = `hsla(${95 + rng() * 25}, 45%, ${l}%, 0.55)`;
    x.fillRect(rng() * 128, rng() * 128, 1 + rng() * 2, 2 + rng() * 3);
  }
  return repeatTex(c);
}

// 주차장: 어두운 포장과 4 m 간격의 흰 선
export function lotTexture() {
  const c = canvas(128, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#44464a';
  x.fillRect(0, 0, 128, 128);
  speckle(x, mulberry32(41), 700, 0.12, 128, 128);
  x.fillStyle = '#c7cacd';
  for (let i = 4; i < 128; i += 32) x.fillRect(i, 0, 2, 96);
  return repeatTex(c);
}

// 먼 도시 윤곽: 안개 낀 건물 그림자. 원통 안쪽에 둘러 붙인다.
export function skylineTexture(seed = 77) {
  const W = 2048, H = 256;
  const c = canvas(W, H);
  const x = c.getContext('2d');
  const rng = mulberry32(seed);
  let px = 0;
  while (px < W) {
    const w = 10 + rng() * 30;
    const h = 24 + Math.pow(rng(), 1.8) * 96; // 낮고 촘촘하게(최대 약 120 칸 = 140 m)
    const shade = 150 + Math.floor(rng() * 40);
    x.fillStyle = `rgb(${shade - 12},${shade},${shade + 14})`;
    x.fillRect(px, H - h, w, h);
    if (rng() < 0.25) x.fillRect(px + w / 2 - 1, H - h - 22, 2, 22); // 안테나
    if (rng() < 0.3) x.fillRect(px + 3, H - h - 6, w - 6, 6); // 옥상 설비
    for (let k = 0; k < w * h * 0.004; k++) {
      x.fillStyle = `rgba(255,236,190,${0.25 + rng() * 0.3})`;
      x.fillRect(px + 2 + rng() * (w - 4), H - h + 4 + rng() * (h - 8), 2, 2);
    }
    px += w + (rng() < 0.4 ? 2 + rng() * 14 : 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
