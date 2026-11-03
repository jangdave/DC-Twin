// 외관 화면 캡처(개발 서버용): node tools/ext_shot.mjs "<쿼리>" 파일이름 ["실행할 JS"] [--url http://127.0.0.1:5173/]
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? '?stage=exterior';
const name = process.argv[3] ?? 'ext';
const url = (process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:5173/') + q;
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 860 });
const logs = [];
p.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text()));
p.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await p.goto(url, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 }).catch(() => logs.push('건물 모델 없음'));
if (process.argv[4]) await p.evaluate(process.argv[4]); // 선택: 카메라를 옮기는 코드
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: `shots/${name}.png` });
console.log(name, logs.length ? logs : 'ok');
await b.close();
