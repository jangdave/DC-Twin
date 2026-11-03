// 깊이 정밀도가 모자라는 기기를 흉내 낸다: 카메라 near를 아주 작게, far를 아주 크게 잡아 깊이 해상도를 낮추고 화면을 찍는다.
// (24비트 깊이에서 near 0.02, far 20000이면 150 m 거리의 해상도가 약 7 cm로, 16비트 깊이 기기와 비슷하게 겹친 면이 다툰다.)
//   node tools/depth_stress.mjs "<쿼리>" 파일이름 [--url ...] [--near 0.02] [--far 20000]
import puppeteer from 'puppeteer-core';
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const q = process.argv[2] ?? '?stage=exterior&q=high';
const name = process.argv[3] ?? 'stress';
const url = arg('--url', 'http://127.0.0.1:5173/') + q;
const near = Number(arg('--near', 0.02));
const far = Number(arg('--far', 20000));
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 860 });
await p.goto(url, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 40000 });
await p.evaluate(([near, far]) => {
  const s = window.__viewer.scene;
  s.controls.minDistance = 0.5; s.controls.enableDamping = false;
  s.camera.position.set(s.center.x + 55, 62, s.center.z + 105);
  s.controls.target.set(s.center.x, 4, s.center.z + 4); s.controls.update();
  window.__stress = null; // 시험 중에 [near, far]를 넣으면 매 프레임 그 값으로 덮어쓴다(예전 코드에도 쓸 수 있게 update를 감싼다)
  const orig = s.update.bind(s);
  s.update = (a, b2) => {
    if (window.__stress) { s.camera.near = window.__stress[0]; s.camera.far = window.__stress[1]; s.camera.updateProjectionMatrix(); }
    orig(a, b2);
    if (window.__stress && (s.camera.near !== window.__stress[0] || s.camera.far !== window.__stress[1])) { s.camera.near = window.__stress[0]; s.camera.far = window.__stress[1]; s.camera.updateProjectionMatrix(); }
  };
}, [near, far]);
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: `shots/${name}.png` });
// 부지 안 여러 지점(부지 중심 기준 m)을 화면에 투영해 그 점의 색을 읽는다. 같은 카메라에서 보통 정밀도와 낮은 정밀도의 색을 비교해,
// 정밀도를 낮췄더니 색이 크게 바뀐 지점(= 깊이 다툼으로 다른 면이 비침)의 개수를 센다. 0이어야 한다.
const pts = [[-55, 44], [-35, 44], [35, 44], [55, 44], [-55, 30], [55, 30], [-58, -10], [58, -35], [-55, -44], [-30, -44], [30, -44], [55, -44], [0, 44], [-20, 40], [20, 40], [-45, -30], [45, 35], [-62, 20], [62, -20], [10, -46]];
const read = async () => {
  await new Promise((r) => setTimeout(r, 900));
  const shot = await (await p.$('#canvas')).screenshot({ encoding: 'base64' });
  return p.evaluate(async ([b64, pts]) => {
    const s = window.__viewer.scene;
    const cv0 = document.getElementById('canvas');
    const r = cv0.getBoundingClientRect();
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    return pts.map(([x, z]) => {
      const v = new s.center.constructor(s.center.x + x, 0.05, s.center.z + z).project(s.camera);
      const px = Math.round(((v.x + 1) / 2) * r.width), py = Math.round(((1 - v.y) / 2) * r.height);
      if (v.z >= 1 || px < 4 || py < 4 || px > im.width - 4 || py > im.height - 4) return null;
      const d = g.getImageData(px - 2, py - 2, 4, 4).data;
      let rr = 0, gg = 0, bb = 0, n = 0; for (let k = 0; k < d.length; k += 4) { rr += d[k]; gg += d[k + 1]; bb += d[k + 2]; n++; }
      return [rr / n, gg / n, bb / n];
    });
  }, [shot, pts]);
};
await p.evaluate(() => { window.__stress = null; });
const normal = await read();
await p.evaluate(([near, far]) => { window.__stress = [near, far]; }, [near, far]);
const stressed = await read();
await p.screenshot({ path: `shots/${name}.png` });
let used = 0, changed = 0;
normal.forEach((c, i) => {
  const d = stressed[i];
  if (!c || !d) return;
  used++;
  if (Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - d[k]))) > 25) changed++;
});
console.log(`${name}: near ${near}, far ${far}, 읽은 지점 ${used}개 중 정밀도를 낮추자 색이 크게 바뀐 지점 ${changed}개`);
await b.close();
process.exitCode = changed === 0 ? 0 : 1;
