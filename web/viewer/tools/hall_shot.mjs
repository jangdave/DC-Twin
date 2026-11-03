// 홀 화면 캡처(개발 서버용): node tools/hall_shot.mjs "<쿼리>" 파일이름 [대기초]
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? '?stage=hall';
const name = process.argv[3] ?? 'hall';
const wait = Number(process.argv[4] ?? 6) * 1000;
const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 860 });
const logs = [];
p.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text()));
p.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await p.goto('http://127.0.0.1:5173/' + q, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__viewer?.scene?.airflow, { timeout: 30000 }).catch(() => logs.push('airflow 없음'));
await new Promise((r) => setTimeout(r, wait));
await p.screenshot({ path: `shots/${name}.png` });
console.log(name, logs.length ? logs : 'ok');
await b.close();
