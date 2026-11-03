// 그리기 부담 측정(개발 서버용): node tools/perf_check.mjs
// 헤드리스 소프트웨어 렌더링(SwiftShader)이라 프레임은 실제 GPU보다 훨씬 낮다. 장면끼리 비교하는 용도다.
import puppeteer from 'puppeteer-core';
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const cases = [];
for (const q of ['high', 'mid', 'low']) {
  cases.push({ name: `외관 PC ${q}`, q: `?stage=exterior&q=${q}`, w: 1440, h: 860, dpr: 1 });
  cases.push({ name: `외관 모바일 ${q}`, q: `?stage=exterior&q=${q}`, w: 390, h: 760, dpr: 3 });
  cases.push({ name: `홀 모바일 ${q}`, q: `?stage=hall&q=${q}`, w: 390, h: 760, dpr: 3 });
}
for (const c of cases) {
  const p = await b.newPage();
  await p.setViewport({ width: c.w, height: c.h, deviceScaleFactor: c.dpr });
  await p.goto('http://127.0.0.1:5173/' + c.q, { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => window.__viewer?.scene?.airflow && window.__viewer.scene.exteriorModel, { timeout: 40000 }).catch(() => {});
  const r = await p.evaluate(async () => {
    const s = window.__viewer.scene;
    await new Promise((r) => setTimeout(r, 1500));
    let n = 0;
    const t0 = performance.now();
    await new Promise((res) => { const f = () => { n++; performance.now() - t0 < 4000 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
    const fps = n / ((performance.now() - t0) / 1000);
    const i = s.renderer.info;
    return { fps: +fps.toFixed(1), calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null };
  });
  console.log(c.name.padEnd(18), JSON.stringify(r));
  await p.close();
}
await b.close();
