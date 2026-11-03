// 빌드 결과(dist)를 헤드리스 Edge/Chrome으로 열어 시나리오별 화면을 캡처하고 콘솔 오류를 모은다 (docs/18 7.2장).
//   npm run build && node tools/screenshot.mjs [--browser 경로] [--out shots]
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const OUT = path.resolve(arg('--out', path.join(HERE, '../shots')));
const CANDIDATES = [
  arg('--browser', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) throw new Error('Edge나 Chrome을 찾지 못했다. --browser 로 경로를 알려 주세요');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(DIST, p === '/' ? 'index.html' : p);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const shots = [
  { name: 'exterior', q: '?scenario=fan_fault&t=240', select: null },
  { name: 'normal', q: '?scenario=normal&t=60&stage=hall', select: 'rack_25' },
  { name: 'fan_fault_early', q: '?scenario=fan_fault&t=20&stage=hall', select: null },
  { name: 'fan_fault_late', q: '?scenario=fan_fault&t=240&stage=hall', select: 'rack_03' },
  { name: 'cooling_failure', q: '?scenario=cooling_failure&t=200&stage=hall', select: null },
  { name: 'power_spike', q: '?scenario=power_spike&t=150&stage=hall', select: null, view: 'power' },
  { name: 'top_labels', q: '?scenario=fan_fault&t=240&stage=hall', select: 'rack_03', preset: 'top', labels: true },
  { name: 'iso_critical', q: '?scenario=power_spike&t=150&stage=hall', select: null, preset: 'iso' },
];
for (const s of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`[${s.name}] ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${s.name}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${s.name}] 요청 실패: ${r.url()}`));
  await page.goto(base + s.q, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__viewer && window.__viewer.state.player, { timeout: 15000 });
  await page.waitForFunction(() => window.__viewer.getModelsState() !== 'loading', { timeout: 15000 });
  await page.evaluate((s) => {
    const v = window.__viewer;
    v.state.player.playing = false;
    if (s.view) v.setView(s.view);
    if (s.preset) v.scene.setPreset(s.preset, true);
    if (s.labels) v.scene.setLabels(true);
    if (s.select) v.selectEquipment(s.select, false);
  }, s);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  const info = await page.evaluate(() => {
    const v = window.__viewer;
    return { mode: document.getElementById('mode-badge').textContent, conf: v.store.countConfidence(), alarms: v.store.alarmLog.length, time: v.state.player.time };
  });
  console.log(s.name, JSON.stringify(info));
  await page.close();
}
await browser.close();
server.close();
if (problems.length) {
  console.log(`콘솔 문제 ${problems.length}건:`);
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(' ', p);
} else console.log('콘솔 오류 없음');
