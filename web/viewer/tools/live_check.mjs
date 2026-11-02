// 라이브 모드 확인 (docs/18 7.2장, FR-60~63): 게이트웨이를 녹화 재생으로 띄우고 화면을 붙여 상태와 값을 확인한다.
//   npm run build && node tools/live_check.mjs [--browser 경로]
// 게이트웨이: node gateway/src/index.js --manifest sim/out/sensor_manifest.json --replay <jsonl> --time-scale 20 --loop
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DIST = path.join(HERE, '../dist');
const OUT = path.join(HERE, '../shots');
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const exe = [arg('--browser', ''), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => existsSync(p));
if (!exe) throw new Error('Edge나 Chrome을 찾지 못했다');
const PORT = 18080;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const web = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(DIST, p === '/' ? 'index.html' : p);
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(cond);
  console.log(`${cond ? '통과' : '실패'}  ${name} ${extra}`);
};

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 860 });
page.on('pageerror', (e) => problems.push(e.message));

// 1) 게이트웨이가 없을 때: 연결 실패가 보여야 한다(FR-62)
await page.goto(`${base}?live=ws://127.0.0.1:${PORT}/ws`, { waitUntil: 'networkidle0' });
await sleep(2500);
const failText = await page.$eval('#mode-badge', (e) => e.textContent);
ok('FR-62 게이트웨이 없음 -> 연결 끊김 표시', /끊김/.test(failText), `(${failText})`);
ok('FR-61 라이브에서는 재생 조작을 숨김', await page.$eval('#transport', (e) => e.hidden));

// 2) 게이트웨이를 띄운다
const gw = spawn(process.execPath, [path.join(ROOT, 'gateway/src/index.js'), '--manifest', path.join(ROOT, 'sim/out/sensor_manifest.json'), '--replay', path.join(ROOT, 'sim/out/recordings/fan_fault_l2.jsonl'), '--time-scale', '20', '--loop', '--port', String(PORT)], { cwd: path.join(ROOT, 'gateway'), stdio: ['ignore', 'pipe', 'pipe'] });
let gwLog = '';
gw.stdout.on('data', (d) => (gwLog += d));
gw.stderr.on('data', (d) => (gwLog += d));
try {
  // 재접속(2초 간격)으로 붙는지 본다
  try {
    await page.waitForFunction(() => document.getElementById('mode-badge').textContent.includes('연결됨'), { timeout: 25000 });
  } catch (e) {
    console.log('연결 대기 실패. 게이트웨이 로그:', gwLog.slice(-400));
    console.log('화면 상태:', await page.$eval('#mode-badge', (x) => x.textContent), '|', await page.$eval('#live-text', (x) => x.textContent));
    throw e;
  }
  ok('재접속 후 라이브 연결됨', true);
  await sleep(14000); // 20배속으로 약 280초 분량이 흐르게 둔다(팬 고장 이후 구간)
  const info = await page.evaluate(() => {
    const v = window.__viewer;
    return { conf: v.store.countConfidence(), sensors: v.store.latest.size, alarms: v.store.alarmLog.length, dropped: v.state.live.dropped, ignored: v.store.ignored, badge: document.getElementById('mode-badge').textContent, live: document.getElementById('live-text').textContent };
  });
  console.log(JSON.stringify(info));
  ok('센서 204개가 들어옴', info.sensors === 204, `(${info.sensors})`);
  ok('신뢰 등급이 들어옴(ok와 low)', info.conf.ok + info.conf.low + info.conf.caution > 0, JSON.stringify(info.conf));
  ok('버린 메시지 0건', info.dropped === 0 && info.ignored === 0, `(버림 ${info.dropped}, 무시 ${info.ignored})`);
  await page.screenshot({ path: path.join(OUT, 'live.png') });
} finally {
  gw.kill();
}

// 3) 게이트웨이가 죽으면 값이 오래된 값(회색)이 되고 끊김이 보여야 한다(4.4장)
await page.waitForFunction(() => document.getElementById('mode-badge').textContent.includes('끊김'), { timeout: 20000 });
const stale = await page.evaluate(() => [...window.__viewer.store.latest.values()].filter((e) => e.quality === 'stale').length);
ok('끊기면 값이 오래된 값으로 표시됨', stale > 100, `(${stale}개)`);

// 4) 나쁜 라이브 주소는 거부(FR-63)
await page.goto(`${base}?live=ws://example.com/ws`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__viewer, { timeout: 15000 });
const rejected = await page.evaluate(() => ({ badge: document.getElementById('mode-badge').textContent, mode: window.__viewer.state.mode }));
ok('FR-63 원격 ws:// 거부하고 녹화 재생으로 시작', rejected.mode === 'rec' && /거부/.test(rejected.badge), `(${rejected.badge})`);

await browser.close();
web.close();
if (problems.length) console.log('페이지 오류:', problems.slice(0, 5));
process.exit(results.every(Boolean) && !problems.length ? 0 : 1);
