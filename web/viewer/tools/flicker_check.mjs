// 깜빡임(겹친 면의 깊이 다툼) 점검(개발 서버용): 카메라를 3 cm만 움직인 두 화면을 비교해 크게 달라진 점의 비율을 잰다.
// 겹친 면이 있으면 같은 곳이 프레임마다 다른 색으로 튀어 비율이 올라간다. node tools/flicker_check.mjs [--url http://127.0.0.1:5173/]
import puppeteer from 'puppeteer-core';
const base = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:5173/';
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 700 });
await p.goto(`${base}?stage=exterior&q=high`, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 40000 });
// 장면 이름, 카메라 위치(부지 중심 기준 x, y, z), 바라보는 곳
const views = [
  ['전체', [124, 60, 140], [0, 8, 0]],
  ['남쪽 정문 도로', [4, 6, 150], [0, 2, 60]],
  ['교차로 낮은 시점', [100, 3, 120], [180, 0, 20]],
  ['동쪽 길 멀리', [180, 8, 40], [180, 0, -300]],
  ['정문과 진입로', [20, 10, 100], [0, 0, 55]],
  ['주차장 위', [30, 25, 20], [0, 0, 25]],
  ['건물 남쪽 벽 가까이', [20, 8, 90], [0, 8, 0]],
  ['건물 동쪽 벽', [110, 12, 10], [0, 10, 0]],
  ['건물 북쪽 벽', [-30, 14, -95], [0, 10, 0]],
  ['건물 서쪽 벽 멀리', [-170, 20, 20], [0, 10, 0]],
  ['옥상 위', [40, 55, 40], [0, 18, 0]],
  ['냉각탑과 발전기', [70, 10, 60], [50, 3, -10]],
];
const grab = async (pos, tgt, dx) => {
  await p.evaluate(([pos, tgt, dx]) => {
    const s = window.__viewer.scene;
    s.controls.minDistance = 0.5;
    s.controls.enableDamping = false;
    s.camera.position.set(s.center.x + pos[0] + dx, pos[1], s.center.z + pos[2]);
    s.controls.target.set(s.center.x + tgt[0], tgt[1], s.center.z + tgt[2]);
    s.controls.update();
    s._dirty = true;
  }, [pos, tgt, dx]);
  await new Promise((r) => setTimeout(r, 700));
  return p.screenshot({ encoding: 'base64' });
};
let worst = 0;
for (const [name, pos, tgt] of views) {
  const a = await grab(pos, tgt, 0);
  const c = await grab(pos, tgt, 0.03);
  const frac = await p.evaluate(async ([a, c]) => {
    const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const [ia, ic] = await Promise.all([load(a), load(c)]);
    const cv = document.createElement('canvas');
    cv.width = ia.width; cv.height = ia.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, cv.width, cv.height).data;
    g.drawImage(ic, 0, 0); const dc = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0, tot = 0;
    for (let k = 0; k < da.length; k += 4) {
      const y = (k / 4 / cv.width) | 0;
      if (y < 60 || y > cv.height - 20) continue; // 화면 위 카드는 뺀다
      tot++;
      if (Math.abs(da[k] - dc[k]) + Math.abs(da[k + 1] - dc[k + 1]) + Math.abs(da[k + 2] - dc[k + 2]) > 140) n++;
    }
    return n / tot;
  }, [a, c]);
  worst = Math.max(worst, frac);
  console.log(name.padEnd(14), `${(frac * 100).toFixed(2)}%`);
}
console.log(worst < 0.03 ? '통과(3% 미만)' : '의심: 3% 이상인 장면이 있다');
await b.close();
process.exitCode = worst < 0.03 ? 0 : 1;
