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
await page.goto(`${base}?scenario=fan_fault&t=100&stage=hall`, { waitUntil: 'networkidle0' });
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
await page.evaluate(() => document.getElementById('tab-alarms').click());
await page.evaluate(() => window.__viewer.state.player.seek(200));
await sleep(200);
const alarms200 = await page.$$eval('#alarm-list li', (l) => l.length);
await page.evaluate(() => window.__viewer.state.player.seek(10));
await sleep(200);
const alarms10 = await page.$$eval('#alarm-list li', (l) => l.length);
ok('FR-12 알람 목록이 재생 시각에 따라 달라짐', alarms200 === 2 && alarms10 === 0, `(200초 ${alarms200}건, 10초 ${alarms10}건)`);
await page.evaluate(() => window.__viewer.state.player.seek(200));
await page.waitForSelector('#alarm-list li', { timeout: 5000 });
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
await p2.goto(`${base}?scenario=power_spike&t=150&stage=hall`, { waitUntil: 'networkidle0' });
await p2.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
ok('6.3 동작 줄이기 설정이면 장면이 알고 있음', await p2.evaluate(() => window.__viewer.scene.reducedMotion));

// 9) 외관 → 홀 → 외관 (docs/20 FR-80~86)
const p3 = await browser.newPage();
await p3.setViewport({ width: 1280, height: 800 });
await p3.goto(`${base}?scenario=fan_fault&t=240`, { waitUntil: 'networkidle0' });
await p3.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
const vis = (sel) => p3.$eval(sel, (e) => !e.hidden);
ok('FR-80 처음은 외관: 요약 카드가 보이고 보기 도구와 뒤로 단추는 숨김', (await p3.evaluate(() => window.__viewer.state.stage)) === 'exterior' && (await vis('#exterior-card')) && !(await vis('#stage-tools')) && !(await vis('#back-btn')));
const ext = await p3.evaluate(() => ({ alarms: document.getElementById('ext-alarms').textContent, temp: document.getElementById('ext-temp').textContent }));
ok('FR-82 외관 요약에 알람 수와 최고 입구 온도', /건$/.test(ext.alarms) && ext.temp.includes('°C'), JSON.stringify(ext));
await p3.mouse.click(5, 5); // 하늘이나 빈 곳을 눌러도 들어가지 않는다
await sleep(200);
ok('빈 곳을 누르면 외관 유지', (await p3.evaluate(() => window.__viewer.state.stage)) === 'exterior');
const spot = await p3.evaluate(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  for (let y = 0.45; y < 0.95; y += 0.05) for (let x = 0.3; x < 0.95; x += 0.05) if (window.__viewer.scene.pickBuilding(x, y)) return { x: r.left + x * r.width, y: r.top + y * r.height };
  return null;
});
ok('건물이 화면 안에서 눌릴 위치에 있다', !!spot);
await p3.mouse.click(spot.x, spot.y);
await sleep(1200);
ok('FR-81 건물을 누르면 홀로 들어감', (await p3.evaluate(() => window.__viewer.state.stage)) === 'hall' && (await vis('#stage-tools')) && (await vis('#back-btn')) && !(await vis('#exterior-card')));
const kept = await p3.evaluate(() => ({ sc: window.__viewer.state.scenarioId, t: window.__viewer.state.player.time }));
ok('FR-86 단계가 바뀌어도 시나리오와 재생 위치 유지', kept.sc === 'fan_fault' && kept.t >= 240, JSON.stringify(kept));
await p3.keyboard.press('Escape');
await sleep(1200);
ok('FR-83 Esc로 외관으로 돌아옴', (await p3.evaluate(() => window.__viewer.state.stage)) === 'exterior' && (await vis('#exterior-card')));
await p3.evaluate(() => document.getElementById('canvas').focus());
await p3.keyboard.press('Enter');
await sleep(1200);
ok('Enter로 홀 들어가기', (await p3.evaluate(() => window.__viewer.state.stage)) === 'hall');
await p3.click('#back-btn');
await sleep(300);
ok('"외관으로" 단추', (await p3.evaluate(() => window.__viewer.state.stage)) === 'exterior');
const rej = await p3.evaluate(() => {
  const v = window.__viewer;
  v.dispatch({ name: 'view.goto', value: 'walk' });
  v.dispatch({ name: 'nope' });
  v.dispatch({ name: 'view.layer', value: 'power' });
  v.dispatch({ name: 'view.select', value: 'rack_07' });
  return { rejected: v.queue.rejected, view: v.state.view, sel: v.state.selected, stage: v.state.stage };
});
ok('명령: 모르는 명령은 무시하고 횟수를 세며 올바른 명령은 실행', rej.rejected === 2 && rej.view === 'power' && rej.sel === 'rack_07' && rej.stage === 'exterior', JSON.stringify(rej));
const p4 = await browser.newPage();
await p4.goto(`${base}?stage=hall&scenario=cooling_failure&t=200&view=power`, { waitUntil: 'networkidle0' });
await p4.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
ok('FR-84 주소 매개변수로 홀에서 시작', (await p4.evaluate(() => window.__viewer.state.stage)) === 'hall' && (await p4.$eval('#exterior-card', (e) => e.hidden)));
await p3.evaluate(() => window.__viewer.queue.pending.length === 0 && window.__viewer.flow.stage);
await sleep(1200);
await p3.setViewport({ width: 390, height: 844 });
await sleep(600);
const mx = await p3.evaluate(() => {
  const c = document.getElementById('exterior-card').getBoundingClientRect();
  const st = document.getElementById('stage').getBoundingClientRect();
  return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, cardH: Math.round(c.height), stageH: Math.round(st.height), cardRight: Math.round(c.right) };
});
ok('6.2 외관 화면도 390px에서 가로 스크롤 없고 카드가 화면 안', mx.sw <= mx.iw + 1 && mx.cardRight <= mx.iw, JSON.stringify(mx));
ok('6.2 외관 카드가 장면 높이의 40% 이하(건물이 가려지지 않음)', mx.cardH <= mx.stageH * 0.4, JSON.stringify(mx));
await p3.screenshot({ path: path.join(OUT, 'stage_exterior_mobile.png') });
await p3.setViewport({ width: 1280, height: 800 });
await p4.waitForFunction(() => window.__viewer.getModelsState() === 'ready', { timeout: 15000 });
const mdl = () => p4.evaluate(() => {
  const sc = window.__viewer.scene;
  return { models: sc.modelMeshes.every((m) => m.visible), box: sc.rackBody.visible, btn: document.getElementById('model-btn').getAttribute('aria-pressed'), opacity: sc.rackFront.material.opacity, n: sc.modelMeshes.length };
});
const m1 = await mdl();
ok('MODEL 장비 모양이 받아지고 기본으로 켜짐(상자는 숨김, 값 판은 반투명)', m1.models && !m1.box && m1.btn === 'true' && m1.opacity < 1 && m1.n >= 15, JSON.stringify(m1));
await p4.click('#model-btn');
const m2 = await mdl();
ok('MODEL 단추로 단순 상자로 되돌림(값 판은 불투명)', !m2.models && m2.box && m2.btn === 'false' && m2.opacity === 1, JSON.stringify(m2));
const picked = await p4.evaluate(() => {
  const sc = window.__viewer.scene;
  for (let y = 0.3; y < 0.9; y += 0.04) for (let x = 0.2; x < 0.9; x += 0.04) { const e = sc.pick(x, y); if (e) return e; }
  return null;
});
ok('MODEL 상자 모드에서도 선택(레이캐스트)이 됨', !!picked, String(picked));
await p4.click('#model-btn');
const picked2 = await p4.evaluate(() => {
  const sc = window.__viewer.scene;
  for (let y = 0.3; y < 0.9; y += 0.04) for (let x = 0.2; x < 0.9; x += 0.04) { const e = sc.pick(x, y); if (e) return e; }
  return null;
});
ok('MODEL 장비 모양 모드에서도 숨긴 상자로 선택이 됨', !!picked2, String(picked2));
const p6 = await browser.newPage();
await p6.goto(`${base}?stage=hall&models=0`, { waitUntil: 'networkidle0' });
await p6.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
ok('MODEL models=0이면 받지 않고 상자만 씀', (await p6.evaluate(() => window.__viewer.getModelsState())) === 'off' && (await p6.$eval('#model-btn', (e) => e.hidden)));
// 화질 단계: 낮음은 랙 모델을 자동으로 받지 않고 단추로 받는다. 차량 없음, 입자 적음
const pq = await browser.newPage();
await pq.goto(`${base}?stage=hall&q=low`, { waitUntil: 'networkidle0' });
await pq.waitForFunction(() => window.__viewer?.scene?.airflow, { timeout: 30000 }).catch(() => {});
const lowInfo = await pq.evaluate(() => {
  const v = window.__viewer;
  return { tier: v.scene.tier, models: v.getModelsState(), btnHidden: document.getElementById('model-btn').hidden, pressed: document.getElementById('model-btn').getAttribute('aria-pressed'), particles: v.scene.airflow.active, shadow: v.scene.sunExt.castShadow, sel: document.getElementById('quality-sel').value };
});
ok('Q 낮음: 랙 모델은 자동으로 받지 않고 단추만 보임, 입자 2500, 그림자 없음', lowInfo.tier === 'low' && lowInfo.models === 'deferred' && !lowInfo.btnHidden && lowInfo.pressed === 'false' && lowInfo.particles === 2500 && !lowInfo.shadow && lowInfo.sel === 'low', JSON.stringify(lowInfo));
await pq.evaluate(() => document.getElementById('model-btn').click());
await pq.waitForFunction(() => window.__viewer.scene.modelsReady, { timeout: 30000 }).catch(() => {});
ok('Q 낮음: 단추를 누르면 랙 모델을 받아 보여 줌', await pq.evaluate(() => window.__viewer.scene.modelsReady && window.__viewer.scene.modelMeshes.every((m) => m.visible)));
await pq.close();
const pm = await browser.newPage();
await pm.goto(`${base}?stage=exterior`, { waitUntil: 'networkidle0' });
await pm.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 }).catch(() => {});
const midInfo = await pm.evaluate(() => {
  const s = window.__viewer.scene;
  return { tier: s.tier, blocks: s.city.plan.blocks.length, cars: s.city.group.children.some((c) => c.isInstancedMesh && c.count === 60), shadow: s.sunExt.castShadow };
});
ok('Q 자동 시험 브라우저는 보통(도시 블록 48, 차량 60, 그림자)', midInfo.tier === 'mid' && midInfo.blocks === 48 && midInfo.cars && midInfo.shadow, JSON.stringify(midInfo));
await pm.close();
// UX 구조: 오른쪽 패널 탭, 범례와 상태 표시의 위치, 상단 높이
const pu = await browser.newPage();
await pu.setViewport({ width: 1440, height: 860 });
await pu.goto(`${base}?scenario=cooling_failure&t=200&stage=hall`, { waitUntil: 'networkidle0' });
await pu.waitForFunction(() => window.__viewer?.state.player, { timeout: 30000 });
const ux1 = await pu.evaluate(() => {
  const sel = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('#side-tabs [data-tab]')].filter((t) => !t.hidden).map((t) => t.dataset.tab);
  const active = () => [...document.querySelectorAll('#side-tabs [aria-selected="true"]')].map((t) => t.dataset.tab);
  const out = { tabs, first: active(), header: sel('top').getBoundingClientRect().height, legendInStage: sel('stage').contains(sel('legend')), badgeInStage: sel('stage').contains(sel('mode-badge')), scenarioInSummary: sel('pane-summary').contains(sel('scenario-select')) };
  out.paneCount = document.querySelectorAll('.pane:not([hidden])').length;
  return out;
});
ok('UX 탭은 요약, 장비, 알람(조작은 숨김)이고 처음에는 요약만 열림', JSON.stringify(ux1.tabs) === '["summary","detail","alarms"]' && JSON.stringify(ux1.first) === '["summary"]' && ux1.paneCount === 1, JSON.stringify(ux1));
ok('UX 상단은 한 줄(64px 이하), 범례와 상태 표시는 3D 화면 안, 시나리오 선택은 요약 탭 안', ux1.header <= 64 && ux1.legendInStage && ux1.badgeInStage && ux1.scenarioInSummary, JSON.stringify(ux1));
const badgeN = await pu.$eval('#tab-alarm-count', (e) => ({ hidden: e.hidden, n: e.textContent }));
ok('UX 알람 탭에 알람 개수 표시', !badgeN.hidden && Number(badgeN.n) >= 1, JSON.stringify(badgeN));
await pu.evaluate(() => window.__viewer.selectEquipment('rack_21', false));
await sleep(300);
ok('UX 장비를 고르면 "장비" 탭이 열리고 고른 것을 풀면 요약으로 돌아감', (await pu.evaluate(() => document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab)) === 'detail');
await pu.evaluate(() => window.__viewer.selectEquipment(null, false));
await sleep(200);
ok('UX 선택을 풀면 요약으로 돌아감', (await pu.evaluate(() => document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab)) === 'summary');
await pu.focus('#tab-summary');
await pu.keyboard.press('ArrowRight');
ok('UX 탭은 좌우 화살표로 옮겨 감', (await pu.evaluate(() => document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab)) === 'detail');
await pu.evaluate(() => document.querySelector('#mode-group [data-mode="sim"]').click());
await sleep(400);
const ux2 = await pu.evaluate(() => ({ control: !document.getElementById('tab-control').hidden, active: document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab }));
ok('UX 직접 시뮬레이션이면 "조작" 탭이 나타나 열림', ux2.control && ux2.active === 'control', JSON.stringify(ux2));
await pu.evaluate(() => window.__viewer.selectEquipment('rack_21', false));
await sleep(300);
ok('UX 조작 중에 장비를 골라도 조작 탭에 머무름', (await pu.evaluate(() => document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab)) === 'control');
await pu.evaluate(() => document.querySelector('#mode-group [data-mode="rec"]').click());
await sleep(400);
const ux3 = await pu.evaluate(() => ({ control: document.getElementById('tab-control').hidden, active: document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab }));
ok('UX 녹화로 돌아가면 조작 탭이 사라지고 요약으로 감', ux3.control && ux3.active !== 'control', JSON.stringify(ux3));
await pu.close();
const pmo = await browser.newPage();
await pmo.setViewport({ width: 390, height: 800, deviceScaleFactor: 2 });
await pmo.goto(`${base}?stage=hall`, { waitUntil: 'networkidle0' });
await pmo.waitForFunction(() => window.__viewer?.state.player, { timeout: 30000 });
const mo = await pmo.evaluate(() => ({ header: document.getElementById('top').getBoundingClientRect().height, sw: document.documentElement.scrollWidth, iw: innerWidth, tabs: document.getElementById('side-tabs').getBoundingClientRect().width, modeScroll: getComputedStyle(document.getElementById('mode-group')).overflowX }));
ok('UX 좁은 화면(390px): 상단 150px 이하, 가로 스크롤 없음', mo.header <= 150 && mo.sw <= mo.iw, JSON.stringify(mo));
await pmo.close();
// 하늘 반사: 장면 전체에는 걸지 않고 유리와 금속 재질에만 건다. 나머지(바닥, 도로, 콘크리트, 벽돌, 지붕, 식재)는 반사하지 않는 재질(Lambert)이라 보는 각도에 따라 색이 변하지 않는다.
const prf = await browser.newPage();
await prf.goto(`${base}?stage=exterior&q=high`, { waitUntil: 'networkidle0' });
await prf.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 }).catch(() => {});
const rf = await prf.evaluate(() => {
  const s = window.__viewer.scene;
  const refl = [...s.city.reflective, ...(s._reflective ?? [])].map((r) => r.mat);
  const bad = [];
  const seen = new Set();
  for (const root of [s.city.group, s.exteriorModel]) {
    root.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        if (seen.has(m) || refl.includes(m)) continue;
        seen.add(m);
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) bad.push(m.name || m.type);
      }
    });
  }
  return { sceneEnv: s.scene.environment === null, reflective: refl.length, allWithEnv: refl.every((m) => !!m.envMap), badStandard: bad, ground: s.ground.material.type };
});
ok('REFLECT 높음: 장면 전체 반사 없음, 유리와 금속에만 반사 지도, 나머지는 Lambert(표준 재질이 남아 있지 않음)', rf.sceneEnv && rf.reflective > 4 && rf.allWithEnv && rf.badStandard.length === 0 && rf.ground === 'MeshLambertMaterial', JSON.stringify(rf));
await prf.close();
// 건물 모델과 공기 흐름
const p7 = await browser.newPage();
await p7.goto(`${base}?scenario=cooling_failure&t=30&stage=exterior`, { waitUntil: 'networkidle0' });
await p7.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 }).catch(() => {});
const extInfo = await p7.evaluate(() => {
  const s = window.__viewer.scene;
  return { model: !!s.exteriorModel, sky: s.sky.visible, fog: !!s.scene.fog, box: s.building.length, hallLights: s.hallLights.visible };
});
ok('EXT 건물 모델과 하늘이 보이고 홀 조명은 꺼짐', extInfo.model && extInfo.sky && extInfo.fog && !extInfo.hallLights, JSON.stringify(extInfo));
await p7.evaluate(() => document.getElementById('sky-btn').click());
ok('EXT 저녁 단추로 하늘이 바뀜', (await p7.evaluate(() => window.__viewer.scene.skyName)) === 'dusk' && (await p7.$eval('#sky-btn', (e) => e.textContent)).includes('낮'));
await p7.evaluate(() => document.getElementById('sky-btn').click());
ok('EXT 다시 누르면 낮', (await p7.evaluate(() => window.__viewer.scene.skyName)) === 'day');
await p7.evaluate(() => window.__viewer.dispatch?.({ name: 'view.goto', args: ['hall'] }));
await p7.evaluate(() => document.getElementById('enter-btn')?.click());
await p7.waitForFunction(() => window.__viewer.scene.stage === 'hall' && window.__viewer.scene.airflow, { timeout: 20000 }).catch(() => {});
const f1 = await p7.evaluate(() => {
  const s = window.__viewer.scene;
  return { has: !!s.airflow, btn: !document.getElementById('flow-btn').hidden, vis: s.airflow?.points.visible, fog: s.scene.fog, lights: s.hallLights.visible };
});
ok('FLOW 홀에서 공기 흐름 입자가 보이고 단추가 있음, 안개는 꺼짐', f1.has && f1.btn && f1.vis && !f1.fog && f1.lights, JSON.stringify(f1));
await p7.evaluate(() => document.getElementById('flow-btn').click());
ok('FLOW 단추로 끔', (await p7.evaluate(() => window.__viewer.scene.airflow.points.visible)) === false);
await p7.evaluate(() => document.getElementById('flow-btn').click());
await p7.evaluate(() => window.__viewer.state.player.seek(200)); // 60초에 CRAC_02 정지
await sleep(1200);
const fan = await p7.evaluate(() => window.__viewer.scene.airflow.fan.map((v) => +v.toFixed(2)));
ok('FLOW CRAC_02가 멈추면 속도장에 반영됨(팬 비율 0)', fan[1] < 0.05 && fan[0] > 0.9, JSON.stringify(fan));
const card = await p4.evaluate(() => ({ title: document.getElementById('sc-title').textContent, desc: document.getElementById('sc-desc').textContent.length, max: document.getElementById('sc-max').textContent, ev: [...document.querySelectorAll('#sc-events li')].map((l) => l.textContent) }));
ok('CARD 시나리오 설명과 가장 높은 입구 온도, 일어나는 일이 보임', card.title.length > 1 && card.desc > 5 && /Rack_\d+ [\d.]+ °C/.test(card.max) && card.ev.length >= 1 && card.ev[0].includes('CRAC_02'), JSON.stringify(card));
await p4.evaluate(() => document.querySelector('#sc-events li').click());
await sleep(300);
ok('CARD 일어나는 일을 누르면 그 시각으로 이동', (await p4.evaluate(() => window.__viewer.state.player.time)) >= 59);
await p4.evaluate(() => window.__viewer.state.player.seek(250));
await sleep(1500);
await p4.evaluate(() => document.getElementById('sc-max').click());
await sleep(300);
ok('CARD 가장 높은 입구 온도 랙을 누르면 선택됨', (await p4.evaluate(() => window.__viewer.state.selected)) !== null);
await p3.screenshot({ path: path.join(OUT, 'stage_exterior.png') });

// 10) 직접 시뮬레이션(docs/21): 브라우저가 간이 모델로 계산하고 조작이 반영된다
const p5 = await browser.newPage();
await p5.setViewport({ width: 1280, height: 800 });
await p5.goto(`${base}?stage=hall&mode=sim&scenario=normal`, { waitUntil: 'networkidle0' });
await p5.waitForFunction(() => window.__viewer?.state.sim, { timeout: 15000 });
const vis5 = (sel) => p5.$eval(sel, (e) => !e.hidden);
ok('SIM 직접 시뮬레이션으로 시작: 패널이 보이고 시간 막대와 반복은 숨김', (await vis5('#sim-panel')) && !(await vis5('#timebar')) && !(await vis5('#loop-label')) && (await p5.$eval('#mode-badge', (e) => e.textContent)).includes('직접 시뮬레이션'));
ok('SIM CRAC 슬라이더 8개, 줄 슬라이더 6개', (await p5.$$eval('#sim-fans input', (l) => l.length)) === 8 && (await p5.$$eval('#sim-rows input', (l) => l.length)) === 6);
ok('SIM 첫 값이 바로 보임(센서 204개, 입구 온도 18~20도)', await p5.evaluate(() => {
  const v = window.__viewer;
  const t = v.store.metric('rack_01', 'temp_in');
  return v.store.latest.size === 204 && t && t.value > 17.5 && t.value < 20.5 && !t.confidence;
}));
await sleep(2600);
ok('SIM 실제 시간에 맞춰 진행(2초 이상)', (await p5.evaluate(() => window.__viewer.state.sim.time)) >= 2);
await p5.evaluate(() => {
  const input = document.querySelector('#sim-fans input[aria-label="CRAC_02 팬 속도"]');
  input.value = '0';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const before = await p5.evaluate(() => Math.max(...[...Array(60).keys()].map((i) => window.__viewer.store.metric(`rack_${String(i + 1).padStart(2, '0')}`, 'temp_in').value)));
const after = await p5.evaluate(() => {
  const v = window.__viewer;
  v.state.sim.speed = 10;
  for (let i = 0; i < 40; i++) v.state.sim.advance(1);
  return { max: Math.max(...[...Array(60).keys()].map((i) => v.store.metric(`rack_${String(i + 1).padStart(2, '0')}`, 'temp_in').value)), alarms: v.store.alarmLog.length, fan: v.state.sim.engine.fan.crac_02 };
});
ok('SIM CRAC_02를 끄면 가장 높은 입구 온도가 3도 이상 오름', after.fan === 0 && after.max > before + 3, JSON.stringify({ before, ...after }));
await sleep(700); // 화면 조각은 0.25초 간격으로 갱신된다
ok('SIM 알람이 생기고 조작 기록에 남음', after.alarms > 0 && (await p5.$$eval('#sim-log li', (l) => l.length)) >= 1);
await sleep(600);
await p5.evaluate(() => document.getElementById('tab-alarms').click());
ok('SIM 알람 목록이 화면에 나옴', (await p5.$$eval('#alarm-list li', (l) => l.length)) > 0);
await p5.evaluate(() => window.__viewer.selectEquipment('rack_05', true));
await sleep(200);
ok('SIM 랙을 선택하면 "선택한 랙만" 슬라이더가 나타남', await vis5('#sim-selected'));
await p5.select('#scenario-select', 'power_spike');
await sleep(500);
const reset = await p5.evaluate(() => ({ fan: window.__viewer.state.sim.engine.fan.crac_02, t: window.__viewer.state.sim.time, sc: window.__viewer.state.simScenario, slider: document.querySelector('#sim-fans input[aria-label="CRAC_02 팬 속도"]').value }));
ok('SIM 시나리오를 바꾸면 처음부터 다시 시작하고 슬라이더도 되돌아옴', reset.fan === 1 && reset.t < 20 && reset.sc === 'power_spike' && reset.slider === '100', JSON.stringify(reset));
await p5.click('#mode-group [data-mode="rec"]');
await sleep(800);
ok('SIM 녹화 재생으로 돌아오면 패널이 숨고 시간 막대가 다시 보임', !(await vis5('#sim-panel')) && (await vis5('#timebar')) && (await p5.$eval('#mode-badge', (e) => e.textContent)).includes('녹화'));
await p5.click('#mode-group [data-mode="sim"]');
await sleep(500);
ok('SIM 다시 직접 시뮬레이션으로 전환', (await vis5('#sim-panel')) && (await p5.evaluate(() => window.__viewer.state.mode)) === 'sim');
await p5.screenshot({ path: path.join(OUT, 'sim_mode.png') });

await browser.close();
web.close();
const bad = [...new Set(errors)];
ok('콘솔 오류 없음', bad.length === 0, bad.slice(0, 3).join(' | '));
process.exit(results.every(Boolean) ? 0 : 1);
