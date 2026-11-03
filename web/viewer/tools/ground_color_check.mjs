// 바닥 색이 보는 각도와 화질(반사 켬/끔)에 따라 달라지는지 점검(개발 서버용).
// 같은 카메라로 반사를 켠 화질(high)과 끈 화질(mid)의 바닥 평균 색을 비교하고, 각도마다 평균 색이 얼마나 변하는지도 잰다.
//   node tools/ground_color_check.mjs [--url http://127.0.0.1:5173/]
import puppeteer from 'puppeteer-core';
const base = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:5173/';
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// 주차장(부지 남서쪽, 건물 앞)을 낮은 각도부터 높은 각도까지 같은 곳을 보는 시점들. 높이가 낮을수록 비스듬히 본다.
const spots = [['아주 낮게', 1.6], ['낮게', 4], ['보통', 12], ['높게', 40]];
const mean = {};
for (const q of ['high', 'mid']) {
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 600 });
  await p.goto(`${base}?stage=exterior&q=${q}`, { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 40000 });
  mean[q] = [];
  for (const [, h] of spots) {
    await p.evaluate((h) => {
      const s = window.__viewer.scene;
      s.controls.minDistance = 0.5; s.controls.enableDamping = false;
      s.camera.position.set(s.center.x - 60, h, s.center.z + 45);
      s.controls.target.set(s.center.x - 25, 0, s.center.z + 25);
      s.controls.update(); s._dirty = true;
    }, h);
    await new Promise((r) => setTimeout(r, 600));
    const shot = await (await p.$('#canvas')).screenshot({ encoding: 'base64' }); // 3D 화면만
    // 화면 가운데 아래쪽 상자(바닥이 가득한 곳)의 평균 색
    mean[q].push(await p.evaluate(async (b64) => {
      const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const d = g.getImageData(Math.round(im.width * 0.35), Math.round(im.height * 0.62), Math.round(im.width * 0.3), Math.round(im.height * 0.3)).data;
      let r = 0, gr = 0, bl = 0, n = 0;
      for (let k = 0; k < d.length; k += 4) { r += d[k]; gr += d[k + 1]; bl += d[k + 2]; n++; }
      return [r / n, gr / n, bl / n];
    }, shot));
  }
  await p.close();
}
await b.close();
const fmt = (c) => c.map((v) => v.toFixed(0)).join(',').padStart(11);
let worst = 0;
console.log('시점        반사 켬(high)  반사 끔(mid)  차이(최대 채널)');
spots.forEach(([name], i) => {
  const diff = Math.max(...mean.high[i].map((v, k) => Math.abs(v - mean.mid[i][k])));
  worst = Math.max(worst, diff);
  console.log(name.padEnd(8), fmt(mean.high[i]), '   ', fmt(mean.mid[i]), '   ', diff.toFixed(1));
});
// 각도에 따른 변화: 같은 화질 안에서 낮은 각도와 높은 각도의 평균 색 차이
const spread = (arr) => Math.max(...[0, 1, 2].map((k) => Math.max(...arr.map((c) => c[k])) - Math.min(...arr.map((c) => c[k]))));
console.log(`각도에 따른 변화(high): ${spread(mean.high).toFixed(1)}, (mid): ${spread(mean.mid).toFixed(1)}`);
console.log(worst < 14 ? '통과(화질 사이 차이 14 미만)' : '의심: 반사를 켜고 끌 때 바닥 색이 크게 다르다');
process.exitCode = worst < 14 ? 0 : 1;
