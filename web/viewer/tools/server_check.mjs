// 로컬 계산 서버 연결 확인 (docs/21 4장): 파이썬 서버를 띄우고 웹 화면을 붙여 값, 조작, 거절, 재접속을 확인한다.
//   npm run build && node tools/server_check.mjs [--browser 경로] [--solver l0]
// 서버: cd sim/sensors && uv run --python 3.13 --extra serve python -m dct_sensors.serve --manifest ../out/sensor_manifest.json --speed 10 --port 18765
// sim/out/sensor_manifest.json과 uv가 있어야 한다(저장소에 올라가지 않는 파일이라 CI에서는 돌리지 않는다).
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
const manifest = path.join(ROOT, 'sim/out/sensor_manifest.json');
if (!existsSync(manifest)) throw new Error('sim/out/sensor_manifest.json이 없다(scripts/usd_tools/build_manifest.py로 만든다)');
const PORT = 18765;
const solver = arg('--solver', 'l0');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
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
  results.push(!!cond);
  console.log(`${cond ? '통과' : '실패'}  ${name} ${extra}`);
};

let srv = null;
let srvLog = '';
function startServer() {
  srv = spawn('uv', ['run', '--python', '3.13', '--extra', 'serve', 'python', '-m', 'dct_sensors.serve', '--manifest', manifest, '--solver', solver, '--speed', '10', '--port', String(PORT), '--origin', base.replace(/\/$/, '')], {
    cwd: path.join(ROOT, 'sim/sensors'),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => (srvLog += d));
}
async function stopServer() {
  if (!srv) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(srv.pid), '/T', '/F']);
  else srv.kill();
  srv = null;
  await sleep(800);
}
async function waitPort(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r) return true;
    } catch {
      /* 아직 */
    }
    await sleep(500);
  }
  return false;
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
try {
  startServer();
  ok('서버가 뜸', await waitPort(), solver);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${base}?stage=hall&server=ws://127.0.0.1:${PORT}/ws&models=0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__viewer?.state.live?.state === 'open', { timeout: 20000 });
  await page.waitForFunction(() => window.__viewer.store.latest.size === 204, { timeout: 20000 });
  ok('SERVER 연결되고 센서 204개가 들어옴', true);
  ok('SERVER 조작 패널이 보이고 서버 모드 표시', !(await page.$eval('#sim-panel', (e) => e.hidden)) && (await page.$eval('#sim-panel h2', (e) => e.textContent)) === '로컬 서버 조작' && !(await page.$eval('#sim-speed', (e) => e.hidden)) && (await page.$eval('#mode-badge', (e) => e.textContent)).includes('로컬 서버'));
  ok('SERVER 재생 조작은 숨김, 시나리오 선택은 열림', (await page.$eval('#transport', (e) => e.hidden)) && !(await page.$eval('#scenario-select', (e) => e.disabled)));

  const maxIn = () => page.evaluate(() => Math.max(...[...Array(60).keys()].map((i) => window.__viewer.store.metric(`rack_${String(i + 1).padStart(2, '0')}`, 'temp_in')?.value ?? 0)));
  const before = await maxIn();
  await page.evaluate(() => {
    const input = document.querySelector('#sim-fans input[aria-label="CRAC_02 팬 속도"]');
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__viewer.store.events.some((e) => e.kind === 'crac_fan' && e.target === 'crac_02' && e.value === 0), { timeout: 15000 });
  ok('SERVER 조작이 서버에서 이벤트로 돌아옴', true);
  await page.waitForFunction(() => window.__viewer.store.metric('crac_02', 'fan_speed')?.value < 5, { timeout: 15000 });
  ok('SERVER CRAC_02 팬 속도 센서 값이 0 근처로 내려감', true);
  await page.waitForFunction(
    (b) => Math.max(...[...Array(60).keys()].map((i) => window.__viewer.store.metric(`rack_${String(i + 1).padStart(2, '0')}`, 'temp_in')?.value ?? 0)) > b + 3,
    { timeout: 60000 },
    before,
  );
  ok('SERVER 가장 높은 입구 온도가 3도 이상 오르고 알람이 남', (await page.evaluate(() => window.__viewer.store.alarmLog.length)) > 0, `(${before.toFixed(1)} -> ${(await maxIn()).toFixed(1)})`);
  ok('SERVER 조작 기록 목록에 남음', (await page.$$eval('#sim-log li', (l) => l.length)) >= 1);

  // 두 번째 화면: 접속하면 서버의 조작 상태로 슬라이더가 맞춰진다(snapshot의 controls)
  const p2 = await browser.newPage();
  await p2.goto(`${base}?stage=hall&server=ws://127.0.0.1:${PORT}/ws&models=0`, { waitUntil: 'networkidle0' });
  await p2.waitForFunction(() => window.__viewer?.store.controls !== null && window.__viewer.store.latest.size === 204, { timeout: 20000 });
  await sleep(1200);
  ok('SERVER 새로 접속한 화면의 슬라이더가 서버 상태(CRAC_02 0%)로 맞춰짐', (await p2.$eval('#sim-fans input[aria-label="CRAC_02 팬 속도"]', (e) => e.value)) === '0');

  // 잘못된 조작은 서버가 거절하고 화면에 이유가 보인다(배경 탭은 화면 갱신이 멈추므로 앞으로 가져온다)
  await page.bringToFront();
  await page.evaluate(() => window.__viewer.state.live.send({ type: 'control', kind: 'crac_fan', target: 'crac_99', value: 0.5 }));
  await page.waitForFunction(() => window.__viewer.state.live.lastError?.message, { timeout: 10000 });
  await sleep(600);
  ok('SERVER 거절 이유가 화면에 보임', (await page.$eval('#live-text', (e) => e.textContent)).includes('서버가 거절함'));

  // 시나리오 바꾸기: 서버가 처음부터 다시 시작하고 슬라이더가 되돌아온다
  await page.select('#scenario-select', 'power_spike');
  await page.waitForFunction(() => window.__viewer.store.scenario === 'power_spike', { timeout: 15000 });
  await sleep(1500);
  ok('SERVER 시나리오를 바꾸면 서버가 다시 시작하고 슬라이더가 되돌아옴', (await page.$eval('#sim-fans input[aria-label="CRAC_02 팬 속도"]', (e) => e.value)) === '100');
  await page.screenshot({ path: path.join(OUT, 'server_mode.png') });

  // 서버 속도 단추
  await page.evaluate(() => document.querySelector('#sim-speed [data-xspeed="5"]').click());
  await sleep(500);

  // 서버를 끄면 연결 끊김이 보이고, 다시 켜면 이어서 붙는다(FR-62)
  await stopServer();
  await page.waitForFunction(() => window.__viewer.state.live.state === 'closed', { timeout: 15000 });
  ok('SERVER 서버를 끄면 연결 끊김 표시', (await page.$eval('#mode-badge', (e) => e.textContent)).includes('끊김'));
  const sentWhileDown = await page.evaluate(() => window.__viewer.state.live.send({ type: 'control', kind: 'speed', value: 2 }));
  ok('SERVER 끊긴 동안 조작은 보내지 않음', sentWhileDown === false);
  startServer();
  await waitPort();
  await page.waitForFunction(() => window.__viewer.state.live.state === 'open', { timeout: 30000 });
  ok('SERVER 서버를 다시 켜면 자동으로 다시 붙음', true);

  // 허용하지 않은 출처는 서버가 거절한다
  const refused = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve('open');
        ws.onerror = () => resolve('error');
      }),
    `ws://127.0.0.1:${PORT}/ws`,
  );
  ok('SERVER 허용한 출처(이 화면)는 붙음. 허용하지 않은 출처 거절은 파이썬 시험이 확인', refused === 'open');

  // "로컬 서버" 단추와 대화상자
  const p3 = await browser.newPage();
  await p3.bringToFront();
  await p3.goto(`${base}?stage=hall&models=0`, { waitUntil: 'networkidle0' });
  await p3.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await p3.evaluate(() => document.querySelector('#mode-group [data-mode="server"]').click());
  ok('SERVER 단추를 누르면 연결 대화상자가 열림', await p3.$eval('#server-dialog', (d) => d.open));
  await p3.evaluate(() => {
    document.getElementById('server-url').value = 'ws://example.com/ws';
    document.getElementById('server-connect').click();
  });
  ok('SERVER 이 컴퓨터가 아닌 ws://는 대화상자에서 거절', (await p3.$eval('#server-dialog', (d) => d.open)) && !(await p3.$eval('#server-error', (e) => e.hidden)));
  await p3.evaluate((url) => {
    document.getElementById('server-url').value = url;
    document.getElementById('server-connect').click();
  }, `ws://127.0.0.1:${PORT}/ws`);
  await p3.waitForFunction(() => window.__viewer.state.live?.state === 'open', { timeout: 20000 });
  ok('SERVER 대화상자로 연결하면 서버 모드가 됨', !(await p3.$eval('#server-dialog', (d) => d.open)) && (await p3.evaluate(() => window.__viewer.state.server)));
} finally {
  await stopServer();
  await browser.close();
  web.close();
}
const bad = [...new Set(problems)];
ok('콘솔 오류 없음', bad.length === 0, bad.slice(0, 3).join(' | '));
if (results.includes(false)) console.log(`서버 로그 끝부분:\n${srvLog.slice(-600)}`);
process.exit(results.every(Boolean) ? 0 : 1);
