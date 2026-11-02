// 화면 조작 확인 (docs/18 7.2장): 선택, 키보드, 재생 조작, 시나리오 전환, 보기 값, 도움말, 좁은 화면.
//   npm run build && node tools/ui_check.mjs [--browser 경로]
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const OUT = path.join(HERE, '../shots');
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const exe = [arg('--browser', ''), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => existsSync(p));
if (!exe) throw new Error('Edge나 Chrome을 찾지 못했다');

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
  results.push(!!cond);
  console.log(`${cond ? '통과' : '실패'}  ${name} ${extra}`);
};

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setViewport({ width: 1440, height: 860 });
await page.goto(`${base}?scenario=fan_fault&t=100`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
await page.evaluate(() => (window.__viewer.state.player.playing = false));
await sleep(300);

// 1) 랙을 눌러 선택(FR-30)
const pos = await page.evaluate(() => {
  const v = window.__viewer;
  const c = document.getElementById('canvas');
  const p = v.scene.screenOf('rack_05', c);
  const r = c.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y + 14 };
});
await page.mouse.click(pos.x, pos.y);
await sleep(200);
const sel = await page.evaluate(() => window.__viewer.state.selected);
ok('FR-30 랙을 누르면 선택', typeof sel === 'string' && sel.startsWith('rack'), `(${sel})`);
ok('FR-31 상세 패널에 장비 이름', (await page.$eval('#detail-body .eq-name', (e) => e.textContent)).toLowerCase() === sel);
await page.mouse.click(pos.x, pos.y);
await sleep(200);
ok('같은 곳을 다시 누르면 해제', (await page.evaluate(() => window.__viewer.state.selected)) === null);

// 2) 키보드 이동(FR-34)
await page.focus('#canvas');
await page.evaluate(() => window.__viewer.selectEquipment('rack_05', true));
await page.keyboard.press('ArrowRight');
await sleep(100);
ok('FR-34 오른쪽 화살표: 같은 줄 다음 랙', (await page.evaluate(() => window.__viewer.state.selected)) === 'rack_06');
await page.keyboard.press('ArrowDown');
await sleep(100);
ok('FR-34 아래 화살표: 다음 줄 같은 칸', (await page.evaluate(() => window.__viewer.state.selected)) === 'rack_16');

// 3) 재생 조작(FR-50, 52)
await page.$eval('#canvas', (c) => c.blur());
await page.evaluate(() => document.body.focus());
const t0 = await page.evaluate(() => window.__viewer.state.player.time);
await page.keyboard.press('ArrowRight');
await sleep(150);
const t1 = await page.evaluate(() => window.__viewer.state.player.time);
ok('FR-52 오른쪽 화살표로 5초 이동', Math.abs(t1 - t0 - 5) < 0.5, `(${t0.toFixed(1)} -> ${t1.toFixed(1)})`);
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowLeft');
await page.keyboard.up('Shift');
await sleep(150);
const t2 = await page.evaluate(() => window.__viewer.state.player.time);
ok('FR-52 Shift+왼쪽 화살표로 30초 뒤로', Math.abs(t1 - t2 - 30) < 0.5, `(${t1.toFixed(1)} -> ${t2.toFixed(1)})`);
await page.keyboard.press('Space');
ok('FR-52 스페이스로 재생', await page.evaluate(() => window.__viewer.state.player.playing));
await page.click('#speeds [data-speed="10"]');
ok('FR-50 속도 10배', (await page.evaluate(() => window.__viewer.state.player.speed)) === 10);
await page.click('#play-btn');
ok('FR-50 재생 버튼으로 일시정지', !(await page.evaluate(() => window.__viewer.state.player.playing)));

// 4) 시간 막대로 이동했을 때 알람 목록(FR-11, 12, 40)
await page.evaluate(() => window.__viewer.state.player.seek(200));
await sleep(200);
const alarms200 = await page.$$eval('#alarm-list li', (l) => l.length);
await page.evaluate(() => window.__viewer.state.player.seek(10));
await sleep(200);
const alarms10 = await page.$$eval('#alarm-list li', (l) => l.length);
ok('FR-12 알람 목록이 재생 시각에 따라 달라짐', alarms200 === 2 && alarms10 === 0, `(200초 ${alarms200}건, 10초 ${alarms10}건)`);
await page.evaluate(() => window.__viewer.state.player.seek(200));
await sleep(200);
await page.click('#alarm-list li');
await sleep(900);
ok('FR-40 알람 항목을 누르면 장비 선택', (await page.evaluate(() => window.__viewer.state.selected)) === 'crac_01');

// 5) 시나리오와 보기 값 전환(FR-21, 53)
await page.select('#scenario-select', 'power_spike');
await sleep(500);
const sc = await page.evaluate(() => ({ id: window.__viewer.state.scenarioId, t: window.__viewer.state.player.time, sel: window.__viewer.state.selected }));
ok('FR-53 시나리오 전환: 시각 0, 선택 유지', sc.id === 'power_spike' && sc.t < 1 && sc.sel === 'crac_01', JSON.stringify(sc));
await page.click('input[name="view"][value="power"]');
await sleep(200);
ok('FR-21 보기 값 전환: 범례가 바뀜', (await page.$eval('#legend-title', (e) => e.textContent)) === '전력' && (await page.$eval('#legend-max', (e) => e.textContent)).startsWith('15'));

// 6) 도움말과 안내 문구(FR-70~73)
await page.click('#help-btn');
ok('FR-72 도움말 열림', await page.$eval('#help-dialog', (d) => d.open));
ok('FR-73 등급 설명 4개', (await page.$$eval('#help-conf li', (l) => l.length)) === 4);
await page.keyboard.press('Escape');
ok('FR-70 안내 문구가 항상 보임', (await page.$eval('#disclaimer', (e) => e.textContent)).includes('공학적 정확성'));
ok('FR-71 녹화 모드 표시', (await page.$eval('#mode-badge', (e) => e.textContent)).includes('실시간 아님'));

// 7) 좁은 화면(6.2장): 가로 스크롤이 없어야 한다
for (const [w, h] of [[390, 844], [768, 900]]) {
  await page.setViewport({ width: w, height: h });
  await sleep(500);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(`6.2 ${w}px 폭에서 가로 스크롤 없음`, m.sw <= m.iw + 1, `(${m.sw} / ${m.iw})`);
  await page.screenshot({ path: path.join(OUT, `mobile_${w}.png`), fullPage: true });
}

// 8) 동작 줄이기(6.3장)
const p2 = await browser.newPage();
await p2.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await p2.goto(`${base}?scenario=power_spike&t=150`, { waitUntil: 'networkidle0' });
await p2.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
ok('6.3 동작 줄이기 설정이면 장면이 알고 있음', await p2.evaluate(() => window.__viewer.scene.reducedMotion));

await browser.close();
web.close();
const bad = [...new Set(errors)];
ok('콘솔 오류 없음', bad.length === 0, bad.slice(0, 3).join(' | '));
process.exit(results.every(Boolean) ? 0 : 1);
