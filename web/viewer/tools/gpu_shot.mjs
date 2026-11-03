// 실제 GPU(ANGLE D3D11)로 화면을 찍는다: node tools/gpu_shot.mjs "<쿼리>" 파일이름 ["실행할 JS"] [--url ...]
import puppeteer from 'puppeteer-core';
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const q = process.argv[2] ?? '?stage=exterior&q=high';
const name = process.argv[3] ?? 'gpu';
const js = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
const url = arg('--url', 'http://127.0.0.1:5173/') + q;
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-webgl'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 860 });
await p.goto(url, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 40000 });
const gl = await p.evaluate(() => { const r = window.__viewer.scene.renderer.getContext(); const e = r.getExtension('WEBGL_debug_renderer_info'); return e ? r.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
if (js) await p.evaluate(js);
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: `shots/${name}.png` });
console.log(name, '렌더러:', gl);
await b.close();
