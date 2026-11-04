// 서버실 껍데기(바닥, 벽, 천장, 조명) 다루기. 3D 객체와 무관한 판단은 순수 함수로 두어 시험한다.
import * as THREE from 'three';

// 카메라가 벽 밖이나 천장 위에 있을 때 그 면을 숨겨 안이 보이게 한다. 좌표는 웹 장면 좌표(m)다.
// bounds: {minX, maxX, minZ, maxZ, height}. 반환: 각 이름이 보이는지.
export function shellVisibility(cam, b, margin = 0.05) {
  return {
    wall_west: !(cam.x < b.minX - margin),
    wall_east: !(cam.x > b.maxX + margin),
    wall_north: !(cam.z < b.minZ - margin), // 웹 Z는 -USD y라서 north(+y)가 작은 Z쪽이다
    wall_south: !(cam.z > b.maxZ + margin),
    ceiling: !(cam.y > b.height - margin),
  };
}

// 타일 무늬를 코드로 그린다(원본 이미지가 저장소에 없고 용량을 아끼려고). 한 장이 타일 n x n개다.
export function makeTileTexture(THREE_, { size = 256, n = 4, base = '#4a4f58', grout = '#2b2f36', line = 3 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  // 타일마다 밝기를 조금씩 달리하고 잔 점을 뿌려 단조로움을 줄인다(고정된 난수라 항상 같은 모양)
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const step0 = size / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${(rnd() * 0.07).toFixed(3)})`;
    g.fillRect(i * step0, j * step0, step0, step0);
  }
  for (let k = 0; k < size * 6; k++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${(rnd() * 0.06).toFixed(3)})`;
    g.fillRect(rnd() * size, rnd() * size, 1.5, 1.5);
  }
  g.strokeStyle = grout;
  g.lineWidth = line;
  const step = size / n;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
  }
  const t = new THREE_.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE_.RepeatWrapping;
  t.colorSpace = THREE_.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// 받은 glb를 장면에 맞게 손본다: 바닥과 천장은 타일 무늬, 이름 목록을 돌려준다.
export function prepareShell(root) {
  const parts = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = true;
    o.receiveShadow = false;
    const name = o.name;
    parts.set(name, o);
    if (name === 'floor') {
      o.material.map = makeTileTexture(THREE, { base: '#4b515b', grout: '#262a31', n: 8 });
      o.material.color.set(0xffffff);
    } else if (name === 'ceiling') {
      o.material.map = makeTileTexture(THREE, { base: '#8c919b', grout: '#6b707a', n: 6 });
      o.material.color.set(0xffffff);
    }
    if (o.material.map) o.material.needsUpdate = true;
  });
  return parts;
}
