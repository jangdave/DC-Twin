// 같은 바닥 한 지점을 방위를 바꿔 가며 본 색이 얼마나 달라지는지 점검(개발 서버용).
// 거친 바닥(아스팔트, 인도 등)은 보는 각도에 따라 색이 변하면 안 된다. 높이 4 m, 8 m, 20 m에서 거리는 같게 두고 방위만 바꾼다.
//   node tools/ground_angle_check.mjs [--url http://127.0.0.1:5173/] [--q high]
import puppeteer from 'puppeteer-core';
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const base = arg('--url', 'http://127.0.0.1:5173/');
const q = arg('--q', 'high');
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 600 });
await p.goto(`${base}?stage=exterior&q=${q}`, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 40000 });
// 바닥만 남긴다: 키가 1 m를 넘는 덩어리(건물, 나무, 가로등, 울타리, 차량)와 하늘 윤곽은 숨겨, 시선을 가리는 것 없이 바닥 색만 잰다.
await p.evaluate(() => {
  const s = window.__viewer.scene;
  s.exterior.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.material?.isShaderMaterial) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (o.isInstancedMesh || bb.max.y - bb.min.y > 1.0) o.visible = false;
  });
  if (s.beaconGlow) s.beaconGlow.visible = false;
});
// 점검할 바닥 지점(부지 중심 기준 m): 건물 앞 주차장 아스팔트, 정문 앞 진입로, 잔디, 인도
const spots = { 주차장: [-30, 42], 진입로: [0, 70], 잔디: [-78, 20], 인도: [-100, 20] };
const azimuths = [0, 60, 120, 180, 240, 300];
let worst = 0;
for (const [name, [px, pz]] of Object.entries(spots)) {
  for (const h of [4, 8, 20]) {
    const colors = [];
    for (const az of azimuths) {
      await p.evaluate(([px, pz, h, az]) => {
        const s = window.__viewer.scene;
        s.controls.minDistance = 0.5; s.controls.enableDamping = false;
        const a = (az * Math.PI) / 180, d = 18; // 카메라가 건물 안으로 들어가지 않는 거리
        s.camera.position.set(s.center.x + px + Math.sin(a) * d, h, s.center.z + pz + Math.cos(a) * d);
        s.controls.target.set(s.center.x + px, 0, s.center.z + pz); s.controls.update(); s._dirty = true;
      }, [px, pz, h, az]);
      await new Promise((r) => setTimeout(r, 450));
      const shot = await (await p.$('#canvas')).screenshot({ encoding: 'base64' });
      colors.push(await p.evaluate(async (b64) => {
        const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
        const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
        const w = 8; // 화면 가운데(바닥 지점) 8x8 평균. 낮은 각도에서는 넓게 잡으면 여러 바닥 종류가 섞인다
        const d = g.getImageData(Math.round(im.width / 2 - w / 2), Math.round(im.height / 2 - w / 2), w, w).data;
        let r = 0, gr = 0, bl = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { r += d[k]; gr += d[k + 1]; bl += d[k + 2]; n++; }
        return [r / n, gr / n, bl / n];
      }, shot));
    }
    const spread = Math.max(...[0, 1, 2].map((k) => Math.max(...colors.map((c) => c[k])) - Math.min(...colors.map((c) => c[k]))));
    worst = Math.max(worst, spread);
    console.log(`${name.padEnd(4)} 높이 ${String(h).padStart(2)} m  방위별 변화 ${spread.toFixed(1)}  (${colors.map((c) => c.map((v) => v.toFixed(0)).join(',')).join(' | ')})`);
  }
}
console.log(worst < 8 ? `통과(방위별 변화 최대 ${worst.toFixed(1)} < 8)` : `의심: 방위별 변화 최대 ${worst.toFixed(1)}`);
await b.close();
process.exitCode = worst < 8 ? 0 : 1;
