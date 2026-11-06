// 도심에 쓰는 그림(캔버스로 직접 그린다). 외부 이미지를 쓰지 않는다 (docs/26).
// 모든 그림은 오른쪽 아래 구석에 흰 점이 있어, 지붕처럼 무늬가 없는 면은 그 점을 가리키게 한다.
import * as THREE from 'three';

// 그림 한 장이 덮는 실제 크기(m)와 가로 창 수. 건물 크기에 맞춰 반복 횟수를 정할 때 쓴다.
export const FACADE_TILE = {
  glass: { tw: 12.8, th: 15.2, cols: 4 }, glass2: { tw: 12.8, th: 15.2, cols: 8 },
  ribbon: { tw: 16, th: 14.4, cols: 4 }, ribbon2: { tw: 16, th: 14.4, cols: 4 },
  concrete: { tw: 12, th: 14.4, cols: 4 }, concrete2: { tw: 12, th: 14.4, cols: 2 },
  brick: { tw: 12.8, th: 12, cols: 4 }, brick2: { tw: 12.8, th: 12, cols: 4 },
  metal: { tw: 12.8, th: 14.4, cols: 4 }, metal2: { tw: 12.8, th: 14.4, cols: 4 },
  // 창이 적은 외벽: 작은 구멍창, 세로 틈창, 큰 창 두 층 높이, 창고형 벽
  punched: { tw: 12, th: 14.4, cols: 2 }, punched2: { tw: 12, th: 14.4, cols: 2 },
  slit: { tw: 12.8, th: 14.4, cols: 4 }, slit2: { tw: 12.8, th: 14.4, cols: 4 },
  wide: { tw: 14, th: 14.4, cols: 2 }, wide2: { tw: 14, th: 14.4, cols: 2 },
  solid: { tw: 12.8, th: 14.4, cols: 4 }, solid2: { tw: 12.8, th: 14.4, cols: 4 },
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
let K = 1; // 외벽 그림 배율(1: 256 px, 2: 512, 4: 1024). 그리는 좌표는 항상 256 기준이고 배율만 곱하므로 배치는 단계와 상관없이 같다.

// 밝기를 높이로 보고 법선 지도를 만든다(소벨). 외벽의 창틀, 벽돌 줄눈, 포장 줄눈이 빛에 따라 살짝 들어가 보인다. 가장자리는 이어 붙이도록 감싼다.
export function normalFromCanvas(src, strength = 2) {
  const w = src.width, h = src.height;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  const img = g.createImageData(w, h);
  const at = (x, y) => H[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * w + x) * 4;
      img.data[o] = (nx * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t; // 색 공간 없음(선형)
}
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
  if (K > 1) {
    // 배율이 높을 때만 더하는 미세한 입자와 비 얼룩(위에서 아래로 번지는 옅은 줄). 다른 난수를 써서 배치가 단계마다 달라지지 않게 한다.
    const fr = mulberry32(1000 + K);
    speckle(g, fr, 2600 * K, 0.05);
    for (let i = 0; i < 26; i++) {
      const x = fr() * S, len = 20 + fr() * 70, y = fr() * (S - len);
      const grad = g.createLinearGradient(0, y, 0, y + len);
      grad.addColorStop(0, 'rgba(10,14,18,0.0)');
      grad.addColorStop(0.3, 'rgba(10,14,18,0.07)');
      grad.addColorStop(1, 'rgba(10,14,18,0.0)');
      g.fillStyle = grad;
      g.fillRect(x, y, 1 + fr() * 2.5, len);
    }
  }
  g.fillStyle = '#fff';
  g.fillRect(S - 8, S - 8, 8, 8); // 지붕용 흰 점
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const cols = new Set(CELLS.map((c) => c[0])).size || 4;
  const rows = new Set(CELLS.map((c) => c[1])).size || 4;
  const out = { map: tex(wall, true), glow: tex(glow, true), grid: { cols, rows } };
  if (K >= 2) out.normal = normalFromCanvas(wall, 1.6); // 보통 이상에서만(메모리 절약)
  return out;
}

const GLASS = ['#2b5a78', '#3a7392', '#1f4560', '#4b86a3', '#335f7a'];

// 창 한 칸: 낮에는 하늘이 비치는 어두운 유리. 켜진 창은 발광 그림(glow)에만 그리고, 낮 그림에는 살짝 밝은 푸른 빛만 준다.
let CELLS = []; // 지금 그리는 그림의 창 위치(격자 수를 알아내는 데 쓴다)
function windowCell(a, g, rng, x, y, w, h, lit) {
  CELLS.push([Math.round(x / 4), Math.round(y / 4)]);
  const grad = a.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, GLASS[Math.floor(rng() * GLASS.length)]);
  grad.addColorStop(1, '#16303f');
  a.fillStyle = grad;
  a.fillRect(x, y, w, h);
  a.fillStyle = 'rgba(255,255,255,0.10)';
  a.beginPath();
  a.moveTo(x, y + h * 0.65);
  a.lineTo(x + w * 0.62, y);
  a.lineTo(x + w, y);
  a.lineTo(x, y + h);
  a.fill();
  // 창틀 입체감: 위·왼쪽은 밝게, 아래·오른쪽은 어둡게 한 줄씩
  a.fillStyle = 'rgba(255,255,255,0.16)';
  a.fillRect(x, y, w, 1);
  a.fillRect(x, y, 1, h);
  a.fillStyle = 'rgba(0,0,0,0.28)';
  a.fillRect(x, y + h - 1, w, 1);
  a.fillRect(x + w - 1, y, 1, h);
  // 낮 그림에서는 일부 창만 살짝 밝게(lit). 저녁 불빛은 모든 창을 발광 그림에 칠해 두고 셰이더가 창마다 켤지 정한다:
  // 그림 하나가 건물 전체에 타일처럼 반복되므로 그림에 켜질 창을 고정해 두면 같은 무늬가 격자로 되풀이된다.
  if (lit) {
    a.fillStyle = 'rgba(150,185,215,0.28)';
    a.fillRect(x, y, w, h);
  }
  g.fillStyle = '#ffd28a';
  g.fillRect(x, y, w, h);
}

function newPair() {
  CELLS = [];
  const gk = Math.max(1, K / 2); // 발광 그림은 절반 해상도로 충분하다
  const wall = canvas(S * K, S * K), glow = canvas(S * gk, S * gk);
  const g = glow.getContext('2d');
  g.scale(gk, gk);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const a = wall.getContext('2d');
  a.scale(K, K);
  return [wall, glow, a, g];
}

// 유리 커튼월. 2번: 세로로 긴 판(8열)과 층마다 불투명한 띠
function drawGlass(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = '#1a2a36';
  a.fillRect(0, 0, S, S);
  const cols = v ? 8 : 4;
  const cw = S / cols;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw, y = r * 64;
      windowCell(a, g, rng, x + 2, y + 2, cw - 4, v ? 48 : 60, rng() < 0.3);
      if (v) {
        a.fillStyle = '#586775';
        a.fillRect(x + 2, y + 52, cw - 4, 10);
      }
    }
  }
  return finish(wall, glow, rng);
}

// 띠창 사무동. 2번: 세로 유리 띠와 베이지 기둥
function drawRibbon(rng, v) {
  const [wall, glow, a, g] = newPair();
  if (!v) {
    a.fillStyle = '#a4a8ac';
    a.fillRect(0, 0, S, S);
    for (let r = 0; r < 4; r++) {
      const y = r * 64 + 18;
      for (let c = 0; c < 8; c++) {
        windowCell(a, g, rng, c * 32 + 2, y, 30, 40, rng() < 0.28);
        a.fillStyle = '#6d7378';
        a.fillRect(c * 32, y, 2, 40);
      }
      a.fillStyle = '#6d7378';
      a.fillRect(0, y - 2, S, 2);
      a.fillRect(0, y + 40, S, 2);
    }
  } else {
    a.fillStyle = '#c9c2b4';
    a.fillRect(0, 0, S, S);
    for (let c = 0; c < 4; c++) {
      const x = c * 64 + 14;
      for (let r = 0; r < 4; r++) windowCell(a, g, rng, x, r * 64 + 2, 36, 58, rng() < 0.3);
      a.fillStyle = '#9a9488';
      for (let r = 0; r < 4; r++) a.fillRect(x, r * 64 + 60, 36, 3);
    }
  }
  return finish(wall, glow, rng);
}

// 콘크리트. 2번: 큰 창 두 줄과 발코니 띠
function drawConcrete(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = v ? '#b4aea4' : '#a09a92';
  a.fillRect(0, 0, S, S);
  if (!v) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const x = c * 64 + 14, y = r * 64 + 12;
        a.fillStyle = '#7f7a73';
        a.fillRect(x - 2, y - 2, 40, 44);
        windowCell(a, g, rng, x, y, 36, 40, rng() < 0.32);
      }
      a.fillStyle = '#7a756e';
      a.fillRect(0, r * 64 + 60, S, 4);
    }
  } else {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        const x = c * 128 + 14, y = r * 64 + 10;
        a.fillStyle = '#8a857e';
        a.fillRect(x - 3, y - 3, 106, 46);
        windowCell(a, g, rng, x, y, 100, 40, rng() < 0.3);
        a.fillStyle = '#d8d3ca';
        a.fillRect(x + 49, y, 2, 40);
      }
      a.fillStyle = '#7d786f';
      a.fillRect(0, r * 64 + 52, S, 8);
      a.fillStyle = '#c9c4ba';
      a.fillRect(0, r * 64 + 54, S, 2);
    }
  }
  return finish(wall, glow, rng);
}

// 벽돌. 1번: 붉은 벽돌에 창 한 쌍, 2번: 황갈색 벽돌에 가늘고 긴 쌍창
function drawBrick(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = v ? '#b58b57' : '#8a4a3a';
  a.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 8) {
    a.fillStyle = v ? '#8d6a40' : '#6f3a2d';
    a.fillRect(0, y, S, 1);
    for (let x = (y / 8) % 2 ? 0 : 8; x < S; x += 16) a.fillRect(x, y, 1, 8);
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (!v) {
        const x = c * 64 + 16, y = r * 64 + 14;
        a.fillStyle = '#d9d2c0';
        a.fillRect(x - 3, y - 3, 38, 42);
        windowCell(a, g, rng, x, y, 32, 36, rng() < 0.3);
        a.fillStyle = '#d9d2c0';
        a.fillRect(x + 15, y, 2, 36);
      } else {
        for (const dx of [10, 38]) {
          const x = c * 64 + dx, y = r * 64 + 8;
          a.fillStyle = '#efe8d8';
          a.fillRect(x - 2, y - 3, 20, 46);
          windowCell(a, g, rng, x, y, 16, 40, rng() < 0.3);
        }
      }
    }
  }
  return finish(wall, glow, rng);
}

// 금속 패널. 1번: 세로 핀, 2번: 가로 루버와 큰 창띠
function drawMetal(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = '#b9bec4';
  a.fillRect(0, 0, S, S);
  if (!v) {
    for (let x = 0; x < S; x += 16) {
      a.fillStyle = x % 32 ? '#aab0b7' : '#c8cdd2';
      a.fillRect(x, 0, 8, S);
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) windowCell(a, g, rng, c * 64 + 8, r * 64 + 20, 48, 22, rng() < 0.3);
  } else {
    for (let y = 0; y < S; y += 6) {
      a.fillStyle = (y / 6) % 2 ? '#8c939a' : '#aeb4ba';
      a.fillRect(0, y, S, 4);
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) windowCell(a, g, rng, c * 128 + 10, r * 64 + 8, 108, 40, rng() < 0.3);
  }
  return finish(wall, glow, rng);
}

// 구멍창: 넓은 벽에 작은 창이 드문드문(층마다 두 칸에 하나). 2번: 짙은 회색 벽에 창 한 쌍
function drawPunched(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = v ? '#8d969e' : '#bdb6a9';
  a.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 32) {
    a.fillStyle = v ? '#7d868e' : '#aaa397';
    a.fillRect(0, y, S, 1);
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 2; c++) {
      const x = c * 128 + (v ? 30 : 46), y = r * 64 + 14;
      a.fillStyle = v ? '#5d656c' : '#8f897d';
      a.fillRect(x - 3, y - 3, (v ? 68 : 40) + 6, 40);
      if (v) {
        windowCell(a, g, rng, x, y, 30, 34, rng() < 0.3);
        windowCell(a, g, rng, x + 38, y, 30, 34, rng() < 0.3);
      } else windowCell(a, g, rng, x, y, 40, 34, rng() < 0.3);
    }
  }
  return finish(wall, glow, rng);
}

// 세로 틈창: 폭이 좁고 긴 창이 일정 간격. 2번: 짙은 벽에 두 층 높이 틈창
function drawSlit(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = v ? '#5f646b' : '#c6c2ba';
  a.fillRect(0, 0, S, S);
  for (let c = 0; c < 4; c++) {
    const x = c * 64 + 26;
    for (let r = 0; r < (v ? 2 : 4); r++) {
      const y = v ? r * 128 + 8 : r * 64 + 6;
      a.fillStyle = v ? '#44484e' : '#9d998f';
      a.fillRect(x - 2, y - 2, 16, (v ? 112 : 54) + 4);
      windowCell(a, g, rng, x, y, 12, v ? 108 : 50, rng() < 0.3);
    }
  }
  return finish(wall, glow, rng);
}

// 큰 창: 두 층 높이의 큰 창이 칸마다 하나. 2번: 짙은 틀에 가로로 긴 창
function drawWide(rng, v) {
  const [wall, glow, a, g] = newPair();
  a.fillStyle = v ? '#4e555c' : '#a4aaa8';
  a.fillRect(0, 0, S, S);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const x = c * 128 + 12, y = r * 128 + (v ? 22 : 12);
      a.fillStyle = v ? '#2f353a' : '#7b8180';
      a.fillRect(x - 3, y - 3, 110, (v ? 84 : 110) + 6);
      windowCell(a, g, rng, x, y, 104, v ? 78 : 104, rng() < 0.3);
    }
  }
  return finish(wall, glow, rng);
}

// 창고형 벽: 거의 막힌 벽에 높은 곳의 작은 창줄. 1번: 골판 금속, 2번: 프리캐스트 판
function drawSolid(rng, v) {
  const [wall, glow, a, g] = newPair();
  if (!v) {
    a.fillStyle = '#b4bab6';
    a.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 6) {
      a.fillStyle = (x / 6) % 2 ? '#a4aaa6' : '#c0c6c2';
      a.fillRect(x, 0, 3, S);
    }
    for (let c = 0; c < 4; c++) windowCell(a, g, rng, c * 64 + 14, 10, 36, 12, rng() < 0.3);
    a.fillStyle = '#6f7571';
    a.fillRect(0, 128, S, 3);
  } else {
    a.fillStyle = '#bcb8b0';
    a.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 64) {
      a.fillStyle = '#9a968e';
      a.fillRect(0, y, S, 2);
    }
    for (let x = 0; x < S; x += 64) a.fillRect(x, 0, 2, S);
    for (let c = 0; c < 4; c++) windowCell(a, g, rng, c * 64 + 12, 22, 40, 14, rng() < 0.3);
  }
  return finish(wall, glow, rng);
}

export function facadeTextures(seed = 5, scale = 1) {
  K = scale;
  const rng = mulberry32(seed);
  const out = {};
  for (const [name, draw] of [['glass', drawGlass], ['ribbon', drawRibbon], ['concrete', drawConcrete], ['brick', drawBrick], ['metal', drawMetal], ['punched', drawPunched], ['slit', drawSlit], ['wide', drawWide], ['solid', drawSolid]]) {
    out[name] = draw(rng, 0);
    out[`${name}2`] = draw(rng, 1);
  }
  return out;
}

function repeatTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 바닥 그림들은 k배 크기로 그린다(1: 기본, 2: 보통, 4: 높음). 좌표는 기본 크기 기준이라 배치는 같고 선명도만 달라진다.
// k가 2 이상이면 포장의 미세한 입자, 얼룩, 균열을 더하고 법선 지도(texture.userData.normalMap)를 붙인다.
function groundCanvas(w, h, k) {
  const c = canvas(w * k, h * k);
  const x = c.getContext('2d');
  x.scale(k, k);
  return [c, x];
}
function withNormal(t, c, k, strength) {
  if (k >= 2) t.userData.normalMap = normalFromCanvas(c, strength);
  return t;
}
function fineGrain(x, seed, w, h, k, n, a = 0.08) {
  const r = mulberry32(seed);
  for (let i = 0; i < n * k; i++) {
    const v = r() < 0.5 ? 0 : 255;
    x.fillStyle = `rgba(${v},${v},${v},${a * r()})`;
    x.fillRect(r() * w, r() * h, 0.5 + r() * 0.8, 0.5 + r() * 0.8);
  }
}
function cracks(x, seed, w, h, n, color) {
  const r = mulberry32(seed);
  x.strokeStyle = color;
  x.lineWidth = 0.35;
  for (let i = 0; i < n; i++) {
    let px = r() * w, py = r() * h;
    x.beginPath();
    x.moveTo(px, py);
    for (let s = 0; s < 5; s++) {
      px += (r() - 0.5) * 9;
      py += (r() - 0.3) * 9;
      x.lineTo(px, py);
    }
    x.stroke();
  }
}

export function roadTexture(k = 1) {
  const [c, x] = groundCanvas(64, 128, k);
  x.fillStyle = '#3b3d41';
  x.fillRect(0, 0, 64, 128);
  const rng = mulberry32(9);
  speckle(x, rng, 900, 0.12, 64, 128);
  if (k >= 2) {
    fineGrain(x, 91, 64, 128, k, 5200, 0.1);
    for (let i = 0; i < 14; i++) { // 타이어 자국이 지나가는 옅은 줄(차선 가운데에서 양쪽으로)
      x.fillStyle = 'rgba(20,20,22,0.05)';
      x.fillRect(12 + (i % 2) * 28 + rng() * 6, 0, 3 + rng() * 4, 128);
    }
    cracks(x, 92, 64, 128, 7, 'rgba(15,15,18,0.45)');
  }
  x.fillStyle = '#d9c25a';
  x.fillRect(30, 8, 4, 48);
  x.fillStyle = '#c9ccd0';
  x.fillRect(3, 0, 2, 128);
  x.fillRect(59, 0, 2, 128);
  return withNormal(repeatTex(c), c, k, 1.1);
}

// 인도: 가로세로 2 m 판 4 x 4장(8 m)
export function sidewalkTexture(k = 1) {
  const [c, x] = groundCanvas(128, 128, k);
  x.fillStyle = '#9a9c9e';
  x.fillRect(0, 0, 128, 128);
  const rng = mulberry32(21);
  speckle(x, rng, 600, 0.1, 128, 128);
  if (k >= 2) {
    fineGrain(x, 211, 128, 128, k, 4200, 0.09);
    for (let i = 0; i < 16; i++) { // 판마다 밝기가 조금씩 다르다
      x.fillStyle = `rgba(${rng() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rng() * 0.04})`;
      x.fillRect((i % 4) * 32 + 1, Math.floor(i / 4) * 32 + 1, 30, 30);
    }
    cracks(x, 212, 128, 128, 6, 'rgba(60,62,64,0.5)');
  }
  x.fillStyle = '#7d8083';
  for (let i = 0; i < 128; i += 32) {
    x.fillRect(i, 0, 1, 128);
    x.fillRect(0, i, 128, 1);
  }
  return withNormal(repeatTex(c), c, k, 1.4);
}

export function grassTexture(k = 1) {
  const [c, x] = groundCanvas(128, 128, k);
  x.fillStyle = '#3f6b34';
  x.fillRect(0, 0, 128, 128);
  const rng = mulberry32(31);
  for (let i = 0; i < 1400; i++) {
    const l = 30 + rng() * 25;
    x.fillStyle = `hsla(${95 + rng() * 25}, 45%, ${l}%, 0.55)`;
    x.fillRect(rng() * 128, rng() * 128, 1 + rng() * 2, 2 + rng() * 3);
  }
  if (k >= 2) {
    const gr = mulberry32(311);
    for (let i = 0; i < 2600 * k; i++) { // 가는 풀잎
      x.fillStyle = `hsla(${88 + gr() * 35}, ${40 + gr() * 20}%, ${24 + gr() * 34}%, ${0.35 + gr() * 0.4})`;
      x.fillRect(gr() * 128, gr() * 128, 0.5 + gr() * 0.7, 1.2 + gr() * 2.4);
    }
    for (let i = 0; i < 90; i++) { // 마른 풀과 흙이 비치는 곳
      x.fillStyle = `rgba(${120 + gr() * 40},${105 + gr() * 30},${60 + gr() * 20},${0.1 + gr() * 0.15})`;
      x.beginPath();
      x.arc(gr() * 128, gr() * 128, 1 + gr() * 3, 0, 6.3);
      x.fill();
    }
  }
  return repeatTex(c);
}

// 주차장: 어두운 포장과 4 m 간격의 흰 선
export function lotTexture(k = 1) {
  const [c, x] = groundCanvas(128, 128, k);
  x.fillStyle = '#44464a';
  x.fillRect(0, 0, 128, 128);
  speckle(x, mulberry32(41), 700, 0.12, 128, 128);
  if (k >= 2) {
    fineGrain(x, 411, 128, 128, k, 4600, 0.1);
    const lr = mulberry32(412);
    for (let i = 0; i < 9; i++) { // 기름 얼룩
      x.fillStyle = `rgba(10,10,12,${0.08 + lr() * 0.1})`;
      x.beginPath();
      x.ellipse(lr() * 128, lr() * 96, 3 + lr() * 6, 2 + lr() * 4, lr() * 3, 0, 6.3);
      x.fill();
    }
    cracks(x, 413, 128, 128, 5, 'rgba(20,20,22,0.45)');
  }
  x.fillStyle = '#c7cacd';
  for (let i = 4; i < 128; i += 32) x.fillRect(i, 0, 2, 96);
  return withNormal(repeatTex(c), c, k, 1.1);
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

// 가까이 볼 때만 겹치는 미세 디테일(입자, 얼룩, 작은 구멍). 이어 붙여도 티가 나지 않는 회색 그림이고 평균 밝기가 0.5다.
// 건물 모델 질감(해상도는 충분하지만 면이 단조로움) 위에 곱하고 요철로 쓴다(scene.js _addDetail).
export function detailTexture(size = 256, seed = 51) {
  const rng = mulberry32(seed);
  const N = size * size;
  const v = new Float32Array(N);
  let wsum = 0;
  for (const [cells, w] of [[4, 0.34], [8, 0.26], [16, 0.18], [32, 0.12], [64, 0.1]]) {
    const g = new Float32Array(cells * cells).map(() => rng());
    const f = cells / size;
    for (let y = 0; y < size; y++) {
      const fy = y * f, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x * f, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        v[y * size + x] += w * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    wsum += w;
  }
  for (let i = 0; i < N; i++) v[i] = v[i] / wsum * 0.78 + (rng() - 0.5) * 0.18 + 0.11; // 미세 입자
  for (let i = 0; i < N / 90; i++) { // 작은 구멍(어둡게)
    const cx = Math.floor(rng() * size), cy = Math.floor(rng() * size), r = 1 + Math.floor(rng() * 2);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) v[((cy + dy + size) % size) * size + ((cx + dx + size) % size)] -= 0.22;
  }
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < N; i++) {
    const b = Math.max(0, Math.min(255, v[i] * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t; // 색 공간 없음(선형 값으로 쓴다)
}
