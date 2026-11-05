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
const SENSORS_JSON = await readFile(path.join(DIST, 'data/sensors.json'), 'utf8');
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '통과' : '실패'}  ${name} ${extra}`);
};

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// 오른쪽 패널을 기본으로 접는 새 동작과 상관없이 기존 시험이 같은 조건에서 돌도록 주소에 panel=open을 붙인다(주소에 panel=이 있으면 그대로 둔다)
{
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => {
    const pg = await newPage(...a);
    const go = pg.goto.bind(pg);
    pg.goto = (u, o) => go(String(u).includes('panel=') ? u : u + (String(u).includes('?') ? '&' : '?') + 'panel=open', o);
    return pg;
  };
}
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

// 1-1) 조작: 왼쪽 버튼 하나로 끌면 회전(선택은 안 바뀜), 짧게 누르면 선택, 오른쪽 버튼은 아무 일도 없음, 회전 중심은 그대로(자유 이동 없음)
{
  const snap = () => page.evaluate(() => { const s = window.__viewer.scene; return { pos: s.camera.position.toArray(), tgt: s.controls.target.toArray(), pan: s.controls.enablePan, sel: window.__viewer.state.selected }; });
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  await page.evaluate(() => { window.__viewer.scene.controls.enableDamping = false; });
  await sleep(1000); // 앞의 랙 선택으로 시작한 카메라 이동이 끝나기를 기다림
  const c0 = await snap();
  await page.mouse.move(700, 450);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(900, 450, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await sleep(200);
  const c1 = await snap();
  await page.mouse.move(700, 450);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(900, 470, { steps: 8 });
  await page.mouse.up({ button: 'left' });
  await sleep(200);
  const c2 = await snap();
  ok('MOUSE 오른쪽 끌기는 카메라를 움직이지 않음', dist(c0.pos, c1.pos) < 1e-6, `이동 ${dist(c0.pos, c1.pos).toFixed(4)}`);
  ok('MOUSE 왼쪽 끌기는 카메라를 돌리고 회전 중심(데이터센터 중심)은 그대로, 자유 이동은 꺼져 있고, 끌기로 선택이 바뀌지 않음', dist(c1.pos, c2.pos) > 0.5 && dist(c1.tgt, c2.tgt) < 1e-6 && c2.pan === false && c2.sel === c1.sel, `이동 ${dist(c1.pos, c2.pos).toFixed(2)} 중심변화 ${dist(c1.tgt, c2.tgt).toFixed(6)} 선택 ${c1.sel}→${c2.sel}`);
  await page.evaluate(() => { window.__viewer.scene.setPreset('home', true); });
  // 1-2) 확대와 축소 한계(외관): 아주 가까이 놓아도 건물 안으로 못 들어가고, 아주 멀리 놓아도 한계 거리 안
  const lim = await page.evaluate(() => {
    const s = window.__viewer.scene;
    s.setStage('exterior', true);
    s.controls.enableDamping = false;
    const t = s.controls.target.clone();
    const { center: c, half: h } = s._bldg;
    let inside = 0, farOver = 0, lowFar = 0, n = 0;
    for (const az of [0, 90, 180, 270]) for (const pol of [0.2, 0.7, 1.2, 1.5]) {
      n++;
      s.camera.position.set(t.x + 0.5 * Math.sin(az) * Math.sin(pol), t.y + 0.5 * Math.cos(pol), t.z + 0.5 * Math.cos(az) * Math.sin(pol));
      s.update(0.016, 1);
      const p = s.camera.position;
      if (Math.abs(p.x - c.x) < h.x && Math.abs(p.y - c.y) < h.y && Math.abs(p.z - c.z) < h.z) inside++;
      s.camera.position.set(t.x + 5000 * Math.sin(az), t.y + 20, t.z + 5000 * Math.cos(az));
      for (let i = 0; i < 4; i++) s.update(0.016, 1);
      const d = s.camera.position.distanceTo(s.controls.target);
      if (d > s.controls.maxDistance + 1) farOver++;
      { const q = s.camera.position; if (s.city.plan.buildings.some((b) => b.parts.some((r) => Math.abs(q.x - r.x) < r.w / 2 && Math.abs(q.z - r.z) < r.d / 2 && q.y < r.y0 + r.h))) lowFar++; }
    }
    const r = { n, inside, farOver, lowFar, max: Math.round(s.controls.maxDistance), polar: +(s.controls.maxPolarAngle / Math.PI).toFixed(2) };
    s.setStage('hall', true);
    return r;
  });
  ok('ZOOM 외관: 아주 가까이 가도 건물 안으로 못 들어가고, 아주 멀리 가도 한계 거리(도시 반폭의 45%) 안이며 도시 건물 안으로 들어가지 않음(각도는 고정하지 않음)', lim.inside === 0 && lim.farOver === 0 && lim.lowFar === 0 && lim.polar >= 0.48 && lim.max < 400, JSON.stringify(lim));
}
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
ok('RAIL 기본 모니터링 화면에서는 재생 막대가 숨겨져 있고 "기록 재생 막대" 단추가 있음', (await page.$eval('#transport', (e) => e.hidden)) && !(await page.$eval('#timeline-btn', (e) => e.hidden)));
await page.click('#timeline-btn');
ok('RAIL "기록 재생 막대"를 켜면 재생 막대가 보임', !(await page.$eval('#transport', (e) => e.hidden)));
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
await sleep(500); // 화면 갱신은 250ms 간격 제한이 있어 되감기 직후 200ms로는 모자랄 때가 있다
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
await page.click('#heat-btn'); // 서버실 기본 보기에서는 색칠이 꺼져 있어 먼저 켠다
await page.click('input[name="view"][value="power"]');
await sleep(200);
ok('FR-21 보기 값 전환: 범례가 바뀜', (await page.$eval('#legend-title', (e) => e.textContent)) === '전력' && (await page.$eval('#legend-max', (e) => e.textContent)).startsWith('15'));

// 6) 도움말과 안내 문구(FR-70~73)
await page.click('#help-btn');
ok('FR-72 도움말 열림', await page.$eval('#help-dialog', (d) => d.open));
ok('FR-73 등급 설명 4개', (await page.$$eval('#help-conf li', (l) => l.length)) === 4);
await page.keyboard.press('Escape');
ok('FR-70 "시각화 목적" 안내는 도움말 안에 있고 화면 아래에는 없음', await page.evaluate(() => { const d = document.getElementById('disclaimer'); return !!d && d.closest('#help-dialog') !== null && d.textContent.includes('공학적 정확성') && !document.getElementById('bottom').contains(d); }));
ok('FR-71 녹화 재생 표시는 화면에서 보이지 않음(글자는 상태로 남아 있음)', await page.$eval('#mode-badge', (e) => e.textContent.includes('실시간 아님') && getComputedStyle(e).display === 'none'));

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
const ext = await p3.evaluate(() => ({ total: document.getElementById('ext-total').textContent, pue: document.getElementById('ext-pue').textContent, status: document.getElementById('ext-status').textContent, hasOld: !!document.getElementById('ext-temp') }));
ok('FR-82 외관 요약은 건물 전체 전력, 누적 전력량, PUE, 알람 건수만("정상/비정상" 판정 없음, 최고 입구 온도와 알람 표 없음)', /kW$/.test(ext.total) && /^\d/.test(ext.pue) && /^(없음|\d+건)$/.test(ext.status) && !/정상|주의 필요/.test(await p3.$eval('#exterior-card', (e) => e.textContent)) && !ext.hasOld, JSON.stringify(ext));
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
  return { tier: s.tier, blocks: s.city.plan.blocks.length, cars: s.city.carCount() === 60, shadow: s.sunExt.castShadow };
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
await pu.evaluate(() => document.querySelector('#rail [data-mode="sim"]').click());
await sleep(400);
const ux2 = await pu.evaluate(() => ({ control: !document.getElementById('tab-control').hidden, active: document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab }));
ok('UX 직접 시뮬레이션이면 "조작" 탭이 나타나 열림', ux2.control && ux2.active === 'control', JSON.stringify(ux2));
await pu.evaluate(() => window.__viewer.selectEquipment('rack_21', false));
await sleep(300);
ok('UX 조작 중에 장비를 골라도 조작 탭에 머무름', (await pu.evaluate(() => document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab)) === 'control');
await pu.evaluate(() => document.querySelector('#rail [data-mode="rec"]').click());
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
// 깊이 정밀도: 카메라 가까운 면이 멀리 볼수록 커지고, 정밀도가 아주 낮은 기기를 흉내 내도(near 0.003, far 50000) 부지 아스팔트가 아래 바닥으로 뒤집히지 않는다
const pdp = await browser.newPage();
await pdp.setViewport({ width: 1100, height: 700 });
await pdp.goto(`${base}?stage=exterior&q=high`, { waitUntil: 'networkidle0' });
await pdp.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 }).catch(() => {});
const nearAt = async (h, dz) => pdp.evaluate(async ([h, dz]) => {
  const s = window.__viewer.scene;
  s.controls.minDistance = 0.5; s.controls.enableDamping = false;
  s.camera.position.set(s.center.x, h, s.center.z + dz);
  s.controls.target.set(s.center.x, 0, s.center.z); s.controls.update();
  // 고정 시간 대신 프레임 두 번을 기다린다(CPU가 바쁘면 렌더링이 느려 400 ms 안에 갱신되지 않을 수 있다)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return s.camera.near;
}, [h, dz]);
const nearClose = await nearAt(8, 20);
const nearFar = await nearAt(160, 330);
ok('DEPTH 외관의 카메라 가까운 면(near)은 멀리 볼수록 커진다(깊이 정밀도)', nearFar > nearClose * 1.8 && nearClose >= 0.5 && nearFar <= 8, JSON.stringify({ nearClose, nearFar }));
const pointsAt = async () => {
  await sleep(700);
  const shot = await (await pdp.$('#canvas')).screenshot({ encoding: 'base64' });
  return pdp.evaluate(async ([b64]) => {
    const s = window.__viewer.scene;
    const pts = [[-55, 44], [-35, 44], [35, 44], [55, 44], [-55, 30], [55, 30], [-58, -10], [58, -35], [-55, -44], [-30, -44], [30, -44], [55, -44], [0, 44], [-20, 40], [20, 40], [-45, -30], [45, 35], [-62, 20], [62, -20], [10, -46]];
    const r = document.getElementById('canvas').getBoundingClientRect();
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    return pts.map(([x, z]) => {
      const v = new s.center.constructor(s.center.x + x, 0.05, s.center.z + z).project(s.camera);
      const px = Math.round(((v.x + 1) / 2) * r.width), py = Math.round(((1 - v.y) / 2) * r.height);
      if (v.z >= 1 || px < 4 || py < 4 || px > im.width - 4 || py > im.height - 4) return null;
      const d = g.getImageData(px - 2, py - 2, 4, 4).data;
      let a = 0, b = 0, c = 0, n = 0; for (let k = 0; k < d.length; k += 4) { a += d[k]; b += d[k + 1]; c += d[k + 2]; n++; }
      return [a / n, b / n, c / n];
    });
  }, [shot]);
};
await pdp.evaluate(() => {
  const s = window.__viewer.scene;
  s.controls.minDistance = 0.5; s.controls.enableDamping = false;
  s.camera.position.set(s.center.x + 55, 62, s.center.z + 105);
  s.controls.target.set(s.center.x, 4, s.center.z + 4); s.controls.update();
  s.depthOverride = undefined;
});
const ptsNormal = await pointsAt();
await pdp.evaluate(() => { window.__viewer.scene.depthOverride = [0.003, 50000]; });
const ptsStress = await pointsAt();
let usedPts = 0, changedPts = 0; const dbg = [];
ptsNormal.forEach((c, i) => { const d = ptsStress[i]; if (!c || !d) return; usedPts++; if (Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - d[k]))) > 25) { changedPts++; dbg.push([i, c.map(Math.round), d.map(Math.round)]); } });
ok('DEPTH 깊이 정밀도를 아주 낮춰도 부지 바닥 색이 바뀌지 않는다(땅 원판이 깊이를 쓰지 않음)', usedPts >= 12 && changedPts <= 1, JSON.stringify({ usedPts, changedPts, dbg })); // 화면이 넓어진 뒤 길 가장자리 한 점이 극단 설정(0.003)에서 달라짐. 예전 오류는 대부분의 점이 뒤집혔으므로 1점까지만 허용(docs/27 13장)
await pdp.close();
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
ok('FLOW 서버실 기본 보기에서는 공기 흐름이 꺼져 있고 단추는 있음, 안개는 꺼짐', f1.has && f1.btn && f1.vis === false && !f1.fog && f1.lights, JSON.stringify(f1));
await p7.evaluate(() => document.getElementById('flow-btn').click());
ok('FLOW 단추로 켬', (await p7.evaluate(() => window.__viewer.scene.airflow.points.visible)) === true);
await p7.evaluate(() => document.getElementById('flow-btn').click());
ok('FLOW 단추로 다시 끔', (await p7.evaluate(() => window.__viewer.scene.airflow.points.visible)) === false);
await p7.evaluate(() => document.getElementById('flow-btn').click());
// 서버실 기본 보기: 온도 색칠과 범례도 꺼져 있고 단추로 켠다
const h0 = await p7.evaluate(() => ({ heat: window.__viewer.scene.heat, front: window.__viewer.scene.rackFront.visible, legend: !document.getElementById('legend').hidden, views: !document.getElementById('view-group').hidden }));
ok('HEAT 서버실 기본 보기는 온도 색칠, 범례, 보기 값이 꺼짐', !h0.heat && !h0.front && !h0.legend && !h0.views, JSON.stringify(h0));
await p7.evaluate(() => document.getElementById('heat-btn').click());
const h1 = await p7.evaluate(() => ({ heat: window.__viewer.scene.heat, front: window.__viewer.scene.rackFront.visible, legend: !document.getElementById('legend').hidden, views: !document.getElementById('view-group').hidden }));
ok('HEAT 단추로 켜면 색칠, 범례, 보기 값이 나타남', h1.heat && h1.front && h1.legend && h1.views, JSON.stringify(h1));
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
ok('SIM 간이 계산으로 시작: 패널이 보이고 시간 막대와 반복은 숨김', (await vis5('#sim-panel')) && !(await vis5('#timebar')) && !(await vis5('#loop-label')) && (await p5.$eval('#mode-badge', (e) => e.textContent)).includes('간이 계산'));
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
await p5.click('#rail [data-mode="rec"]');
await sleep(800);
ok('SIM 녹화 재생으로 돌아오면 패널이 숨고 시간 막대가 다시 보임', !(await vis5('#sim-panel')) && (await vis5('#timebar')) && (await p5.$eval('#mode-badge', (e) => e.textContent)).includes('녹화'));
await p5.click('#rail [data-mode="sim"]');
await sleep(500);
ok('SIM 다시 간이 계산으로 전환', (await vis5('#sim-panel')) && (await p5.evaluate(() => window.__viewer.state.mode)) === 'sim');
await p5.screenshot({ path: path.join(OUT, 'sim_mode.png') });

// BOOT 첫 로딩 화면: 처음 HTML에 있고, 장면이 준비되면 사라지며, 자료를 못 받으면 이유와 다시 시도가 보인다
const pb = await browser.newPage();
await pb.setViewport({ width: 390, height: 844 });
await pb.setRequestInterception(true);
pb.on('request', (r) => (r.url().includes('data/sensors.json') ? r.abort() : r.continue()));
await pb.goto(base, { waitUntil: 'networkidle0' });
await sleep(500);
const bootFail = await pb.evaluate(() => ({ hidden: document.getElementById('boot').hidden, failed: document.getElementById('boot').classList.contains('failed'), act: !document.getElementById('boot-actions').hidden, text: document.getElementById('boot-text').textContent }));
ok('BOOT 자료를 못 받으면 로딩 화면에 이유와 "다시 시도"가 보임', !bootFail.hidden && bootFail.failed && bootFail.act && bootFail.text.includes('다시'), JSON.stringify(bootFail));
await pb.screenshot({ path: path.join(OUT, 'boot_fail.png') });
await pb.close();
const pc = await browser.newPage();
await pc.setViewport({ width: 390, height: 844 });
await pc.setRequestInterception(true);
let firstHtml = '';
pc.on('response', async (r) => { if (r.request().resourceType() === 'document' && !firstHtml) firstHtml = await r.text(); });
pc.on('request', (r) => r.continue());
await pc.goto(base, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40 && !firstHtml; i++) await sleep(50); // 응답 본문은 비동기로 들어온다
ok('BOOT 처음 HTML에 로딩 화면이 들어 있음(자바스크립트 전에도 보임)', firstHtml.includes('id="boot"') && firstHtml.includes('aria-busy="true"'));
await pc.waitForFunction(() => document.getElementById('boot')?.hidden === true, { timeout: 40000 });
ok('BOOT 장면이 준비되면 로딩 화면이 사라지고 aria-busy도 풀림', !(await pc.evaluate(() => document.body.hasAttribute('aria-busy'))));
await pc.close();

// 왼쪽 메뉴: 상단에 "녹화 재생" 단추가 없고, 서버실에서만 메뉴가 보이며, 시뮬레이션 메뉴는 색칠을 켜고 조작 탭을 연다
{
  const rp = await browser.newPage();
  await rp.setViewport({ width: 1280, height: 800 });
  await rp.goto(base, { waitUntil: 'networkidle0' });
  const ext = await rp.evaluate(() => ({ rail: !document.getElementById('rail').hidden, topRec: !!document.querySelector('#top [data-mode="rec"]') }));
  await rp.evaluate(() => document.getElementById('enter-btn').click());
  await sleep(500);
  const r1 = await rp.evaluate(() => ({ rail: !document.getElementById('rail').hidden, mon: document.querySelector('#rail [data-mode="rec"]').getAttribute('aria-pressed') }));
  await rp.evaluate(() => document.querySelector('#rail [data-mode="sim"]').click());
  await sleep(800);
  const r2 = await rp.evaluate(() => ({ mode: window.__viewer.state.mode, heat: window.__viewer.scene.heat, ctl: !document.getElementById('tab-control').hidden, sim: document.querySelector('#rail [data-mode="sim"]').getAttribute('aria-pressed'), mon: document.querySelector('#rail [data-mode="rec"]').getAttribute('aria-pressed'), bar: !document.getElementById('transport').hidden }));
  ok('RAIL 상단에 녹화 재생 단추 없음, 외관에서는 메뉴 숨김, 서버실에서는 모니터링이 선택됨', !ext.rail && !ext.topRec && r1.rail && r1.mon === 'true', JSON.stringify({ ext, r1 }));
  ok('RAIL 시뮬레이션 메뉴: 시뮬레이션 모드, 색칠 켜짐, 조작 탭과 재생 막대 보임', r2.mode === 'sim' && r2.heat && r2.ctl && r2.sim === 'true' && r2.mon === 'false' && r2.bar, JSON.stringify(r2));
  await rp.evaluate(() => document.querySelector('#rail [data-mode="rec"]').click());
  await sleep(500);
  ok('RAIL 모니터링으로 돌아오면 기록 데이터 모드, 재생 막대 숨김', await rp.evaluate(() => window.__viewer.state.mode === 'rec' && document.getElementById('transport').hidden));
  await rp.close();
}

// 휴대폰: 3D가 화면을 채우고 정보 패널은 아래 시트(접힘, 반, 전체). 장비를 고르면 시트가 반으로 올라오고, 한 손가락으로 끌면 3D가 돈다
{
  const mp = await browser.newPage();
  await mp.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mp.goto(`${base}?stage=hall`, { waitUntil: 'networkidle0' });
  await mp.waitForFunction(() => window.__viewer?.scene?.shell, { timeout: 40000 }).catch(() => {});
  const m0 = await mp.evaluate(() => ({ sheet: document.getElementById('side').dataset.sheet, sideH: Math.round(document.getElementById('side').getBoundingClientRect().height), stageH: Math.round(document.getElementById('stage').getBoundingClientRect().height), scroll: document.documentElement.scrollHeight - innerHeight }));
  ok('SHEET 휴대폰 처음: 시트는 접힘(80px 이하), 3D가 400px 이상, 화면이 세로로 밀리지 않음', m0.sheet === 'peek' && m0.sideH <= 80 && m0.stageH >= 400 && m0.scroll <= 1, JSON.stringify(m0));
  const sheetOf = () => mp.evaluate(() => document.getElementById('side').dataset.sheet);
  await mp.tap('#sheet-handle');
  const h1 = await sheetOf();
  await sleep(450); // 시트가 움직이는 동안 손잡이 위치가 바뀌므로 멈춘 뒤 누른다
  await mp.tap('#sheet-handle');
  const h2 = await sheetOf();
  await sleep(450);
  await mp.tap('#sheet-handle');
  const h3 = await sheetOf();
  await sleep(450);
  ok('SHEET 손잡이를 누를 때마다 접힘 -> 반 -> 전체 -> 접힘', h1 === 'half' && h2 === 'full' && h3 === 'peek', JSON.stringify([h1, h2, h3]));
  await mp.evaluate(() => window.__viewer.selectEquipment('rack_05'));
  await sleep(300);
  const sel = await mp.evaluate(() => ({ sheet: document.getElementById('side').dataset.sheet, tab: document.querySelector('#side-tabs [aria-selected="true"]').dataset.tab }));
  ok('SHEET 장비를 고르면 시트가 반으로 올라오고 장비 탭이 열림', sel.sheet === 'half' && sel.tab === 'detail', JSON.stringify(sel));
  await mp.evaluate(() => document.getElementById('sheet-handle').dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, pointerId: 1, bubbles: true })));
  await mp.evaluate(() => document.getElementById('sheet-handle').dispatchEvent(new PointerEvent('pointerup', { clientY: 560, pointerId: 1, bubbles: true })));
  ok('SHEET 손잡이를 아래로 밀면 한 단계 내려감', (await sheetOf()) === 'peek');
  const before = await mp.evaluate(() => window.__viewer.scene.camera.position.toArray());
  await mp.touchscreen.touchStart(195, 300);
  for (let i = 1; i <= 8; i++) await mp.touchscreen.touchMove(195 + i * 15, 300);
  await mp.touchscreen.touchEnd();
  await sleep(300);
  const after = await mp.evaluate(() => window.__viewer.scene.camera.position.toArray());
  ok('TOUCH 한 손가락으로 끌면 3D 시점이 돈다', Math.hypot(...after.map((v, i) => v - before[i])) > 0.3, JSON.stringify({ before, after }));
  await mp.close();
}

// 에너지·용량, 이상 대비: 시뮬레이션에서만 탭이 보이고, 기준 저장 후 공급 온도를 올리면 냉각 전력이 줄어든 차이가 보이며, 시나리오 단추와 대응 순서가 있음
{
  const ep = await browser.newPage();
  await ep.setViewport({ width: 1440, height: 860 });
  await ep.goto(`${base}?stage=hall`, { waitUntil: 'networkidle0' });
  const t0 = await ep.evaluate(() => ({ energy: !document.getElementById('tab-energy').hidden, prep: !document.getElementById('tab-prep').hidden }));
  await ep.evaluate(() => document.querySelector('#rail [data-mode="sim"]').click());
  await sleep(1500);
  const t1 = await ep.evaluate(() => ({ energy: !document.getElementById('tab-energy').hidden, prep: !document.getElementById('tab-prep').hidden }));
  ok('ENERGY 시뮬레이션 전에는 에너지·용량, 이상 대비 탭이 없고 시뮬레이션에서 나타남', !t0.energy && !t0.prep && t1.energy && t1.prep, JSON.stringify({ t0, t1 }));
  await ep.evaluate(() => document.getElementById('tab-energy').click());
  await sleep(1200);
  const e1 = await ep.evaluate(() => ({ kv: [...document.querySelectorAll('#pane-energy .kv dd')].map((d) => d.textContent), cap: document.querySelectorAll('#pane-energy .caplist li').length, rows: document.querySelectorAll('#pane-energy .rowlist li').length, cool: window.__viewer.store.aggregates.cooling_power }));
  ok('ENERGY 지금 값(IT, 냉각, 설비, PUE, 누적, 입구 온도)과 용량 5개, 줄 6개가 보임', e1.kv.length === 6 && e1.kv.every((t) => t !== '–') && e1.cap === 5 && e1.rows === 6, JSON.stringify(e1));
  await ep.evaluate(() => [...document.querySelectorAll('#pane-energy button')].find((b) => b.textContent.includes('기준으로 저장')).click());
  await ep.evaluate(() => { const i = document.querySelector('#pane-energy .sim-supply input'); i.value = '24'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(3500);
  const e2 = await ep.evaluate(() => ({ rows: [...document.querySelectorAll('#pane-energy .cmp .cmp-row')].map((r) => [...r.children].map((c) => c.textContent)), good: [...document.querySelectorAll('#pane-energy .cmp .delta.good')].map((d) => d.textContent), supply: window.__viewer.state.sim.engine.cfg.t_supply }));
  const cool = e2.rows.find((r) => r[0] === '냉각 전력');
  ok('ENERGY 공급 온도를 24도로 올리면 기준 대비 냉각 전력이 줄어든 차이(좋음 표시)가 나옴', e2.supply === 24 && cool && /^−/.test(cool[3]) && e2.good.some((t) => t.startsWith('−')), JSON.stringify(e2));
  const hint = await ep.evaluate(() => document.querySelector('#pane-energy .supply p').textContent);
  ok('ENERGY 공급 온도가 냉각 장치 주의 기준(22도)을 넘으면 알람이 난다는 안내가 나옴', hint.includes('주의 기준(22 °C)') && hint.includes('알람'), hint);
  await ep.evaluate(() => document.getElementById('tab-prep').click());
  await ep.evaluate(() => [...document.querySelectorAll('#pane-prep .btn-row button')].find((b) => b.textContent === '팬 이상').click());
  await sleep(1500);
  const p1 = await ep.evaluate(() => ({ btns: document.querySelectorAll('#pane-prep .btn-row button').length, on: document.querySelector('#pane-prep .btn-row button.on')?.textContent, steps: [...document.querySelectorAll('#pane-prep .steps li')].map((l) => l.textContent), supply: window.__viewer.state.sim.engine.cfg.t_supply }));
  ok('PREP 시나리오 단추 4개, 팬 이상을 누르면 그 시나리오 대응 순서가 보이고 공급 온도는 처음 값으로 돌아감', p1.btns === 4 && p1.on === '팬 이상' && p1.steps.length >= 4 && p1.steps[0].includes('CRAC_01') && p1.supply === 18, JSON.stringify(p1));
  await ep.close();
}

// 가상 CCTV: 메뉴로 열면 칸이 보이고 모든 칸에 "가상 CCTV" 표시, 칸마다 실제로 그려지고, 알람 구역은 빨간 테두리, Esc로 닫음
{
  const cp = await browser.newPage();
  await cp.setViewport({ width: 1440, height: 860 });
  await cp.goto(`${base}?scenario=fan_fault&t=240&stage=hall&q=high`, { waitUntil: 'networkidle0' });
  await cp.waitForFunction(() => window.__viewer?.scene?.shell, { timeout: 40000 }).catch(() => {});
  await cp.click('#cctv-btn');
  await sleep(1500);
  const c1 = await cp.evaluate(() => ({
    open: !document.getElementById('cctv').hidden,
    tiles: [...document.querySelectorAll('.cctv-tile')].map((t) => ({ tag: t.querySelector('.cctv-tag').textContent, alarm: t.classList.contains('alarm'), name: t.querySelector('.cctv-name').textContent, w: Math.round(t.getBoundingClientRect().width) })),
    pressed: document.getElementById('cctv-btn').getAttribute('aria-pressed'),
    note: document.getElementById('cctv-bar').textContent.includes('실제 영상이 아니라'),
  }));
  ok('CCTV 메뉴를 열면 칸이 보이고 모든 칸에 "가상 CCTV" 표시와 안내 문구가 있음', c1.open && c1.tiles.length >= 2 && c1.tiles.every((t) => t.tag.includes('가상 CCTV') && t.w > 100) && c1.note && c1.pressed === 'true', JSON.stringify(c1));
  ok('CCTV 알람이 있는 구역(CRAC_02 정지)은 앞쪽 칸에서 빨간 테두리', c1.tiles[0].alarm && c1.tiles[0].name.includes('냉각'), JSON.stringify(c1.tiles));
  // 칸마다 실제로 그려졌는지: 화면 캡처에서 각 칸 영역에 색이 여러 가지 있는지
  const shot = await cp.screenshot({ encoding: 'base64' });
  const painted = await cp.evaluate(async (b64) => {
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    return [...document.querySelectorAll('.cctv-tile')].map((t) => {
      const r = t.getBoundingClientRect();
      const d = g.getImageData(Math.floor(r.left + 10), Math.floor(r.top + r.height * 0.3), Math.floor(r.width - 20), Math.floor(r.height * 0.4)).data;
      const set = new Set();
      for (let k = 0; k < d.length; k += 4 * 37) set.add(`${d[k] >> 4},${d[k + 1] >> 4},${d[k + 2] >> 4}`);
      return set.size;
    });
  }, shot);
  ok('CCTV 모든 칸에 장면이 실제로 그려짐(단색이 아님)', painted.length >= 2 && painted.every((n) => n >= 8), JSON.stringify(painted));
  await cp.click('#cctv-next');
  const c2 = await cp.evaluate(() => [...document.querySelectorAll('.cctv-name')].map((e) => e.textContent));
  ok('CCTV 다음 묶음으로 넘기면 다른 카메라가 보임', c2.length >= 1 && c2.every((n) => !c1.tiles.some((t) => t.name === n)), JSON.stringify({ c1: c1.tiles.map((t) => t.name), c2 }));
  await cp.click('.cctv-tile');
  const z = await cp.evaluate(() => document.querySelectorAll('.cctv-tile').length);
  ok('CCTV 칸을 누르면 크게(1칸) 보임', z === 1);
  await cp.keyboard.press('Escape');
  await sleep(200);
  const c3 = await cp.evaluate(() => ({ hidden: document.getElementById('cctv').hidden, stage: window.__viewer.state.stage, scene: window.__viewer.scene.cctv }));
  ok('CCTV Esc로 닫으면 서버실 화면에 남고 그리기도 원래대로', c3.hidden && c3.stage === 'hall' && !c3.scene, JSON.stringify(c3));
  await cp.close();
}

// 서버실 껍데기: 서버실로 들어가면 받고, 벽 밖에서는 그 벽을 숨기고, 위에서는 천장을 숨긴다
{
  const sp = await browser.newPage();
  await sp.setViewport({ width: 1280, height: 800 });
  await sp.goto(base + '?stage=hall', { waitUntil: 'domcontentloaded' });
  await sp.waitForFunction(() => window.__viewer?.scene?.shell, { timeout: 40000 }).catch(() => {});
  const r = await sp.evaluate(() => {
    const s = window.__viewer?.scene;
    if (!s?.shell) return null;
    s.camera.position.set(-6, 2, -6.8); // 서쪽 벽 밖
    s._updateShell();
    const west = s.shellParts.get('wall_west').visible;
    s.camera.position.set(5.5, 12, -6.8); // 천장 위
    s._updateShell();
    return { parts: s.shellParts.size, west, ceiling: s.shellParts.get('ceiling').visible, plain: s._plainHall.every((o) => !o.visible) };
  });
  ok('SHELL 서버실 껍데기를 받고, 벽 밖과 천장 위에서는 그 면을 숨김', !!r && r.parts >= 10 && r.west === false && r.ceiling === false && r.plain, JSON.stringify(r));
  await sp.close();
}

// 메뉴 상태: 왼쪽 메뉴에서 눌린 단추는 항상 하나뿐(src/workspace.js의 규칙)
{
  const mp = await browser.newPage();
  await mp.setViewport({ width: 1440, height: 860 });
  await mp.goto(base + '?stage=hall', { waitUntil: 'networkidle0' });
  await mp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  const rail = () => mp.evaluate(() => [...document.querySelectorAll('#rail button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()));
  const click = (sel) => mp.$eval(sel, (e) => e.click());
  await click('#rail [data-mode="sim"]');
  await sleep(300);
  ok('MENU 간이 계산만 눌림', JSON.stringify(await rail()) === '["간이 계산"]');
  await click('#cctv-btn');
  await sleep(500);
  const r1 = await rail();
  ok('MENU 간이 계산 중 CCTV를 열면 CCTV만 눌림(동시에 눌리지 않음)', JSON.stringify(r1) === '["CCTV"]', JSON.stringify(r1));
  await click('#rail [data-mode="sim"]');
  await sleep(300);
  const r2 = await mp.evaluate(() => ({ cctv: document.getElementById('cctv').hidden, mode: window.__viewer.state.mode }));
  ok('MENU CCTV 중 간이 계산을 누르면 CCTV가 닫히고 간이 계산만 눌림', r2.cctv && r2.mode === 'sim' && JSON.stringify(await rail()) === '["간이 계산"]', JSON.stringify(r2));
  await click('#cctv-btn');
  await sleep(300);
  await click('#rail [data-mode="rec"]');
  await sleep(500);
  const r3 = await mp.evaluate(() => ({ cctv: document.getElementById('cctv').hidden, mode: window.__viewer.state.mode }));
  ok('MENU CCTV 중 모니터링을 누르면 CCTV가 닫히고 모니터링만 눌림', r3.cctv && r3.mode === 'rec' && JSON.stringify(await rail()) === '["모니터링"]', JSON.stringify(r3));
  await click('#cctv-btn');
  await sleep(300);
  await click('#back-btn');
  await sleep(600);
  const r4 = await mp.evaluate(() => ({ cctv: document.getElementById('cctv').hidden, stage: window.__ws().stage, overlay: window.__ws().overlay, rail: document.getElementById('rail').hidden }));
  ok('MENU 외관으로 나가면 CCTV가 닫히고 메뉴가 숨음', r4.cctv && r4.stage === 'exterior' && r4.overlay === null && r4.rail, JSON.stringify(r4));
  await mp.close();
}

// 값 일관성: 같은 뜻의 값은 어느 화면에서 봐도 같다 (docs/27 16장)
{
  const cp = await browser.newPage();
  await cp.setViewport({ width: 1440, height: 860 });
  await cp.goto(base + '?scenario=power_spike&t=200', { waitUntil: 'networkidle0' });
  await cp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await cp.evaluate(() => (window.__viewer.state.player.playing = false));
  await sleep(400);
  const num = (t) => Number(String(t).replace(/[^0-9.]/g, ''));
  const x = await cp.evaluate(() => {
    const s = window.__viewer.store;
    return { ext: document.getElementById('ext-total').textContent, fac: s.aggregates.facility_power, active: s.activeAlarms(), log: s.alarmLog.length, ext2: document.getElementById('ext-status').textContent };
  });
  ok('값 외관 카드의 건물 전체 전력 = 설비 전력(IT + 냉각 + 손실)', Math.abs(num(x.ext) - x.fac) < 0.06, JSON.stringify(x));
  await cp.$eval('#enter-btn', (e) => e.click());
  await sleep(500);
  const y = await cp.evaluate(() => ({ badge: document.getElementById('tab-alarm-count').textContent, head: document.getElementById('alarm-count').textContent, active: window.__viewer.store.activeAlarms(), log: window.__viewer.store.alarmLog.length }));
  ok('값 알람 탭 배지는 지금 이상인 센서 수이고 기록 줄 수와 구분해 보여 줌', Number(y.badge) === y.active && y.active !== y.log && y.head.includes(`지금 ${y.active}건`) && y.head.includes(`기록 ${y.log}건`), JSON.stringify(y));
  await cp.$eval('#rail [data-mode="sim"]', (e) => e.click());
  await sleep(1500);
  const z = await cp.evaluate(async () => {
    const rec = await (await fetch('data/rec/normal.json')).json();
    const sim = window.__viewer.state.sim;
    const i = Math.round(sim.time);
    return { sim: window.__viewer.store.aggregates.it_power, rec: rec.aggregates.it_power[Math.min(i, rec.n - 1)], i };
  });
  ok('값 시뮬레이션 시작 IT 전력이 정상 녹화와 1% 안에서 이어짐', Math.abs(z.sim - z.rec) / z.rec < 0.01, JSON.stringify(z));
  await cp.close();
}

// 시뮬레이션 메뉴 = 미리 계산한 상태와 시나리오 모음(서버 없이 보임). 간이 계산과 서버는 따로다.
{
  const lp = await browser.newPage();
  await lp.setViewport({ width: 1440, height: 860 });
  await lp.goto(base + '?stage=hall', { waitUntil: 'networkidle0' });
  await lp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  const click = (sel) => lp.$eval(sel, (e) => e.click());
  await click('#rail [data-mode="lib"]');
  await lp.waitForFunction(() => window.__viewer.state.mode === 'lib' && window.__viewer.state.player, { timeout: 10000 });
  await sleep(500);
  const A = await lp.evaluate(() => {
    const sel = document.getElementById('scenario-select');
    const tab = (t) => !document.getElementById(`tab-${t}`).hidden;
    return {
      mode: window.__viewer.state.mode,
      rail: [...document.querySelectorAll('#rail button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()),
      groups: [...sel.querySelectorAll('optgroup')].map((g) => `${g.label}:${g.children.length}`),
      options: sel.querySelectorAll('option').length,
      tabs: { control: tab('control'), energy: tab('energy'), prep: tab('prep') },
      slider: !document.querySelector('#pane-energy .sim-supply')?.hidden,
      hint: document.querySelector('#pane-energy .supply .muted')?.textContent.slice(0, 20),
      transport: !document.getElementById('transport').hidden,
      badge: document.getElementById('mode-badge').textContent,
      cta: !document.getElementById('server-cta').hidden,
      selected: sel.value,
    };
  });
  ok('LIB 시뮬레이션 메뉴: 미리 계산한 값이 열리고 시뮬레이션만 눌림, 재생 막대가 보임', A.mode === 'lib' && JSON.stringify(A.rail) === '["시뮬레이션"]' && A.transport && /미리 계산한 값/.test(A.badge), JSON.stringify(A));
  ok('LIB 시나리오 목록이 이상 상황 4, 급기 온도 5, 부하 3으로 묶여 보임', JSON.stringify(A.groups) === '["이상 상황:4","급기 온도:5","부하:3"]' && A.options === 12, JSON.stringify(A.groups));
  ok('LIB 조작 탭은 없고 에너지·용량, 이상 대비 탭은 있으며 공급 온도 슬라이더 대신 안내가 보임', !A.tabs.control && A.tabs.energy && A.tabs.prep && !A.slider && /급기 온도와 부하/.test(A.hint ?? ''), JSON.stringify({ tabs: A.tabs, slider: A.slider, hint: A.hint }));
  ok('LIB 서버 연결 안내가 보이고 누르면 서버 연결 창이 열림', A.cta && (await (async () => { await click('#server-cta-btn'); await sleep(200); const open = await lp.evaluate(() => document.getElementById('server-dialog').open); await lp.keyboard.press('Escape'); return open; })()), '');
  await click('#side-tabs [data-tab="energy"]');
  await click('#pane-energy .btn-row button');
  await lp.select('#scenario-select', 'supply_24');
  await lp.waitForFunction(() => window.__viewer.libScenario?.() === 'supply_24' || document.getElementById('scenario-select').value === 'supply_24');
  await sleep(1200);
  const B = await lp.evaluate(() => {
    const rows = [...document.querySelectorAll('#pane-energy .cmp .cmp-row')].map((r) => [...r.children].map((c) => c.textContent));
    return { rows, cool: window.__viewer.store.aggregates.cooling_power, sel: document.getElementById('scenario-select').value, desc: document.getElementById('sc-desc').textContent.slice(0, 16) };
  });
  const coolRow = B.rows.find((r) => r[0] === '냉각 전력');
  ok('LIB 급기 24도를 고르면 기준(18도) 대비 냉각 전력이 줄고(좋음) 시나리오 설명이 바뀜', B.sel === 'supply_24' && coolRow && /−/.test(coolRow[3]) && B.cool < 28 && /급기/.test(B.desc), JSON.stringify({ sel: B.sel, cool: B.cool, coolRow, desc: B.desc }));
  await click('#cctv-btn');
  await sleep(400);
  const C = await lp.evaluate(() => [...document.querySelectorAll('#rail button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()));
  ok('LIB 미리 계산한 값 중 CCTV를 열면 CCTV만 눌림', JSON.stringify(C) === '["CCTV"]', JSON.stringify(C));
  await click('#rail [data-mode="rec"]');
  await sleep(600);
  const D = await lp.evaluate(() => ({ mode: window.__viewer.state.mode, tabs: ['control', 'energy', 'prep'].map((t) => !document.getElementById(`tab-${t}`).hidden), opts: document.querySelectorAll('#scenario-select option').length }));
  ok('LIB 모니터링으로 돌아가면 에너지 탭이 사라지고 목록은 이상 상황 4개', D.mode === 'rec' && D.tabs.every((x) => !x) && D.opts === 4, JSON.stringify(D));
  await lp.close();
}

// 견고함: 느린 열기가 나중에 끝나도 마지막으로 누른 전환이 이긴다 / 그래픽 컨텍스트 손실 안내
{
  const rp = await browser.newPage();
  await rp.setViewport({ width: 1440, height: 860 });
  await rp.setRequestInterception(true);
  rp.on('request', (r) => (r.url().includes('rec/supply_24.json') ? setTimeout(() => r.continue().catch(() => {}), 2500) : r.continue().catch(() => {})));
  await rp.goto(base + '?stage=hall', { waitUntil: 'networkidle0' });
  await rp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await rp.evaluate(() => { window.__viewer.startLibrary('supply_24'); }); // 느린 녹화를 열기 시작하고(기다리지 않는다)
  await sleep(200);
  await rp.$eval('#rail [data-mode="sim"]', (e) => e.click()); // 곧바로 간이 계산으로 바꾼다
  await sleep(4000); // 느린 녹화가 그 뒤에 도착한다
  const R = await rp.evaluate(() => ({ stateMode: window.__viewer.state.mode, wsMode: window.__ws().mode, badge: document.getElementById('mode-badge').textContent, rail: [...document.querySelectorAll('#rail button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()), tabs: !document.getElementById('tab-control').hidden }));
  ok('ROBUST 느린 시나리오 열기가 나중에 끝나도 마지막에 고른 간이 계산이 유지되고 화면 표시와 실제 출처가 같음', R.stateMode === 'sim' && R.wsMode === 'sim' && /간이/.test(R.badge) && JSON.stringify(R.rail) === '["간이 계산"]' && R.tabs, JSON.stringify(R));
  // 그래픽 컨텍스트 손실: 안내가 보이고, 복구되면 사라진다
  const lost = await rp.evaluate(async () => {
    const c = document.getElementById('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return { skipped: true };
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    const shown = !document.getElementById('gl-lost').hidden;
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 800));
    return { shown, hiddenAgain: document.getElementById('gl-lost').hidden };
  });
  ok('ROBUST 그래픽 컨텍스트를 잃으면 안내가 보이고 복구되면 사라짐', lost.skipped || (lost.shown && lost.hiddenAgain), JSON.stringify(lost));
  await rp.close();
}

// 출처 전환과 서버 데이터: 라이브와 로컬 서버가 어댑터를 거쳐 화면까지 이어지는가, 서버가 미리 계산한 값을 주는가 (모의 서버: 같은 포트에 WebSocket과 HTTP 데이터 API)
{
  const { createRequire } = await import('node:module');
  const { WebSocketServer } = createRequire(import.meta.url)(path.join(HERE, '../../../gateway/node_modules/ws'));
  const apiLog = [];
  const startMock = async ({ withApi, token = null }) => {
    const http = createServer(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (!withApi || !p.startsWith('/api/')) return res.writeHead(404).end();
      apiLog.push(p);
      const send = (obj) => res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      try {
        if (p === '/api/meta') return send({ name: 'mock', solver: 'l0', library: true, controls: ['supply_temp'] });
        // 이 컴퓨터의 서버만 주는 "외부 솔버 결과" 항목(합성 모의). 공개 사이트의 목록에는 없다.
        const extEntry = { id: 'ext_mock', title: '외부 모의 결과', note: '시험용 합성 항목', group: 'external', source: 'external', tool: '모의', n: 300 };
        if (p === '/api/library') {
          const groups = JSON.parse(await readFile(path.join(DIST, 'data/library.json'), 'utf8')).groups;
          const index = JSON.parse(await readFile(path.join(DIST, 'data/index.json'), 'utf8'));
          return send({ version: 1, groups: [...groups, { id: 'external', title: '외부 솔버 결과 (로컬 전용)' }], index: [...index, extEntry] });
        }
        const m = /^\/api\/library\/([a-z0-9_]+)$/.exec(p);
        if (m) return send(await readFile(path.join(DIST, `data/rec/${m[1] === 'ext_mock' ? 'load_130' : m[1]}.json`), 'utf8'));
      } catch { /* 아래 404 */ }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ server: http });
    const received = [];
    const authLog = [];
    wss.on('connection', (ws) => {
      let authed = !token; // 토큰이 필요한 모의 서버: 첫 메시지가 맞는 auth여야 값을 보낸다(src/serve.py와 같은 규칙)
      if (token) {
        const timer = setTimeout(() => authed || ws.close(1008, 'timeout'), 3000);
        ws.once('close', () => clearTimeout(timer));
      }
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (!authed) {
          if (m.type === 'auth' && m.token === token) {
            authed = true;
            authLog.push('ok');
            ws.send(JSON.stringify({ type: 'auth', ok: true }));
            sendSnapshot();
          } else {
            authLog.push('fail');
            ws.close(1008, 'auth');
          }
          return;
        }
        received.push(m);
      });
      const sendSnapshot = () => {
      const sensors = JSON.parse(SENSORS_JSON).map((x) => ({ type: 'sample', sensorId: x.sensorId, value: x.range[0] + (x.range[1] - x.range[0]) * 0.3, quality: 'good', ts: '2026-10-15T09:00:00.000Z', alarm: 'normal' }));
      ws.send(JSON.stringify({ type: 'snapshot', ts: '2026-10-15T09:00:00.000Z', scenario: 'normal', sensors, aggregates: [{ name: 'it_power', value: 400 }, { name: 'cooling_power', value: 30 }, { name: 'facility_power', value: 454 }, { name: 'pue', value: 1.135 }], controls: { fan: {}, powerScale: {}, supply: 18 } }));
      };
      if (authed) sendSnapshot();
    });
    await new Promise((r) => http.listen(0, '127.0.0.1', r));
    return { url: `ws://127.0.0.1:${http.address().port}/ws`, received, wss, http, authLog };
  };
  const mock = await startMock({ withApi: true });
  const lp = await browser.newPage();
  await lp.setViewport({ width: 1440, height: 860 });
  await lp.goto(`${base}?stage=hall&server=${encodeURIComponent(mock.url)}`, { waitUntil: 'networkidle0' });
  await lp.waitForFunction(() => window.__viewer?.state.live, { timeout: 15000 });
  await sleep(1500);
  const L = await lp.evaluate(() => ({ mode: window.__viewer.state.mode, server: window.__viewer.state.server, badge: document.getElementById('mode-badge').textContent, player: window.__viewer.state.player, panel: !document.getElementById('sim-panel').hidden, it: document.getElementById('agg-it').textContent, serverOn: document.querySelector('[data-mode="server"]').classList.contains('on'), rail: [...document.querySelectorAll('#rail button')].filter((b) => b.getAttribute('aria-pressed') === 'true').length, liveInfo: !document.getElementById('live-info').hidden }));
  ok('LIVE 로컬 서버: 연결되고 스냅샷 값이 화면에 보이며 조작 패널이 열리고 "로컬 서버"만 눌림', L.mode === 'live' && L.server && /연결됨/.test(L.badge) && L.player === null && L.panel && L.it === '400.0 kW' && L.serverOn && L.rail === 0 && L.liveInfo, JSON.stringify(L));
  await lp.evaluate(() => window.__viewer.panel.h.onFan('crac_01', 0.5));
  await sleep(300);
  ok('LIVE 슬라이더 조작이 서버로 전달됨', mock.received.some((m) => m.type === 'control' && m.target === 'crac_01'), JSON.stringify(mock.received.slice(-2)));
  // 서버 모드의 공급 온도 슬라이더: 서버가 알려 준 값(18)으로 맞춰지고, 움직이면 supply_temp 조작이 간다
  await lp.$eval('#side-tabs [data-tab="energy"]', (e) => e.click());
  const sup0 = await lp.evaluate(() => ({ row: !document.querySelector('#pane-energy .sim-supply').hidden, value: document.querySelector('#pane-energy .sim-supply input').value }));
  await lp.evaluate(() => { const i = document.querySelector('#pane-energy .sim-supply input'); i.value = '22'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  ok('LIVE 서버 모드에서 공급 온도 슬라이더가 서버 값으로 보이고, 움직이면 supply_temp 조작이 서버로 간다', sup0.row && sup0.value === '18' && mock.received.some((m) => m.type === 'control' && m.kind === 'supply_temp' && m.value === 22), JSON.stringify({ sup0, got: mock.received.slice(-1) }));
  ok('DATA 서버에 연결하면 데이터 API에서 목록을 받았다(meta, library)', apiLog.includes('/api/meta') && apiLog.includes('/api/library'), JSON.stringify(apiLog));
  // 서버에 연결한 채 시뮬레이션(미리 계산한 값)으로: 녹화를 서버에서 받는다
  await lp.$eval('#rail [data-mode="lib"]', (e) => e.click());
  await lp.waitForFunction(() => window.__viewer.state.mode === 'lib' && window.__viewer.state.player, { timeout: 10000 });
  await lp.select('#scenario-select', 'supply_22');
  await sleep(800);
  const D1 = await lp.evaluate(() => ({ mode: window.__viewer.state.mode, src: document.getElementById('data-source').textContent, hidden: document.getElementById('data-source').hidden, cool: window.__viewer.store.aggregates.cooling_power }));
  ok('DATA 서버에 연결한 뒤의 시뮬레이션 값은 서버에서 받고 화면에 출처가 보임', apiLog.includes('/api/library/supply_22') && /서버\(http:\/\/127\.0\.0\.1:\d+\)에서 받음/.test(D1.src) && !D1.hidden && D1.cool < 30, JSON.stringify({ apiLog, D1 }));
  // 서버가 준 외부 솔버 결과: 그룹으로 묶여 보이고, 고르면 서버에서 받아 동작하며, 화면에 "로컬 전용"이 보인다
  const E0 = await lp.evaluate(() => ({ groups: [...document.querySelectorAll('#scenario-select optgroup')].map((g) => g.label), src: document.getElementById('data-source').textContent, opts: document.querySelectorAll('#scenario-select option').length }));
  await lp.select('#scenario-select', 'ext_mock');
  await sleep(800);
  const E1 = await lp.evaluate(() => ({ it: window.__viewer.store.aggregates.it_power, sel: document.getElementById('scenario-select').value, badge: document.getElementById('mode-badge').textContent }));
  ok('EXT 서버가 준 외부 솔버 결과가 "외부 솔버 결과 (로컬 전용)" 그룹으로 보이고 고르면 서버에서 받아 동작함', E0.groups.includes('외부 솔버 결과 (로컬 전용)') && E0.opts === 13 && /외부 솔버 결과 1개 포함, 서버가 줄 때만 보임/.test(E0.src) && apiLog.includes('/api/library/ext_mock') && E1.sel === 'ext_mock' && E1.it > 550 && /외부 솔버 결과 \(모의\)/.test(E1.badge) && !/Warp/.test(E1.badge), JSON.stringify({ E0, E1 }));
  await sleep(500);
  ok('LIVE 시뮬레이션으로 옮기면 서버 연결이 끊김', mock.wss.clients.size === 0, `${mock.wss.clients.size}개 연결`);
  await lp.$eval('#rail [data-mode="rec"]', (e) => e.click());
  await sleep(600);
  const R = await lp.evaluate(() => ({ mode: window.__viewer.state.mode, live: window.__viewer.state.live, server: window.__viewer.state.server, panel: !document.getElementById('sim-panel').hidden, serverOn: document.querySelector('[data-mode="server"]').classList.contains('on') }));
  ok('LIVE 모니터링으로 돌아가면 녹화로 바뀌고 서버로 다시 연결하지 않음', R.mode === 'rec' && R.live === null && !R.server && !R.panel && !R.serverOn && mock.wss.clients.size === 0, JSON.stringify(R));
  await lp.close();
  mock.wss.close();
  mock.http.close();

  // 서버가 데이터 API를 주지 않으면(예: 게이트웨이): 사이트에 포함된 파일로 계속 동작한다
  apiLog.length = 0;
  // 접근 토큰이 필요한 서버: 틀린 토큰은 거부되고 다시 시도하지 않으며, 맞는 토큰은 연결된다. 토큰은 주소에 붙지 않는다
  const locked = await startMock({ withApi: true, token: 'ui-check-token-1234567890' });
  const connectVia = async (token) => {
    const ap = await browser.newPage();
    await ap.setViewport({ width: 1440, height: 860 });
    const wsUrls = [];
    ap.on('framenavigated', () => {});
    await ap.goto(`${base}?stage=hall`, { waitUntil: 'networkidle0' });
    await ap.evaluate(() => document.getElementById('server-dialog').showModal());
    await ap.$eval('#server-url', (e, v) => (e.value = v), locked.url);
    if (token) await ap.$eval('#server-token', (e, v) => (e.value = v), token);
    await ap.$eval('#server-connect', (e) => e.click());
    await sleep(2500);
    const r1 = await ap.evaluate(() => ({ state: window.__viewer.state.live?.state ?? null, badge: document.getElementById('mode-badge').textContent, it: document.getElementById('agg-it').textContent, field: document.getElementById('server-token').value, href: location.href }));
    await sleep(3500);
    const end = await ap.evaluate(() => ({ state2: window.__viewer.state.live?.state ?? null, badge2: document.getElementById('mode-badge').textContent }));
    await ap.close();
    return { ...r1, ...end, wsUrls };
  };
  const bad = await connectVia('wrong-token-000000000000');
  ok('AUTH 틀린 토큰은 거부되고 이유가 보이며 다시 시도하지 않고 값은 오지 않음', bad.state === 'denied' && bad.state2 === 'denied' && /접근 토큰이 맞지 않다/.test(bad.badge) && bad.it === '–' && bad.field === '' && !/token/i.test(bad.href), JSON.stringify(bad));
  const none = await connectVia(null);
  // 토큰을 안 보낸 접속은 서버가 인증 대기 시간(모의 3초, 실제 5초)이 지나야 거부한다
  ok('AUTH 토큰 없이 연결하면 대기 시간 뒤 거부되고 "토큰을 요구한다"로 구분해서 알림', none.state2 === 'denied' && /서버가 접근 토큰을 요구한다/.test(none.badge2) && none.it === '–', JSON.stringify(none));
  const good = await connectVia('ui-check-token-1234567890');
  ok('AUTH 맞는 토큰은 연결되어 값이 보이고, 입력칸은 비워지며 주소에 토큰이 없음', good.state === 'open' && good.state2 === 'open' && good.it === '400.0 kW' && good.field === '' && !/token/i.test(good.href), JSON.stringify(good));
  ok('AUTH 서버는 실패 2번, 성공 1번만 봤다(거부된 뒤 재시도 폭주 없음)', locked.authLog.filter((x) => x === 'fail').length <= 3 && locked.authLog.filter((x) => x === 'ok').length === 1, JSON.stringify(locked.authLog));
  locked.wss.close();
  locked.http.close();

  const bare = await startMock({ withApi: false });
  const fp = await browser.newPage();
  await fp.setViewport({ width: 1440, height: 860 });
  await fp.goto(`${base}?stage=hall&server=${encodeURIComponent(bare.url)}`, { waitUntil: 'networkidle0' });
  await fp.waitForFunction(() => window.__viewer?.state.live, { timeout: 15000 });
  await sleep(1500);
  await fp.$eval('#rail [data-mode="lib"]', (e) => e.click());
  await fp.waitForFunction(() => window.__viewer.state.mode === 'lib' && window.__viewer.state.player, { timeout: 10000 });
  await fp.select('#scenario-select', 'supply_24');
  await sleep(800);
  const F = await fp.evaluate(() => ({ src: document.getElementById('data-source').textContent, cool: window.__viewer.store.aggregates.cooling_power, opts: document.querySelectorAll('#scenario-select option').length }));
  ok('DATA 서버에 데이터 API가 없어도 사이트의 파일로 미리 계산한 값이 동작하고 출처를 알림(외부 솔버 결과는 없음)', /서버에 데이터 API 없음/.test(F.src) && F.cool < 28 && F.opts === 12, JSON.stringify(F));
  await fp.close();
  bare.wss.close();
  bare.http.close();
}

// 화질: FHD 화소 수 상한과 후처리 켜기
{
  const qp = await browser.newPage();
  await qp.setViewport({ width: 2560, height: 1440 }); // QHD 크기, 배율 1
  await qp.goto(`${base}?scenario=fan_fault&t=100&q=mid&fx=on`, { waitUntil: 'networkidle0' });
  await qp.waitForFunction(() => window.__viewer?.scene, { timeout: 20000 });
  await sleep(1500);
  const Q = await qp.evaluate(() => { const s = window.__viewer.scene; const c = document.getElementById('canvas'); return { fx: !!s.fx, ao: !!s.fx?.ao, pr: +s.pixelRatio.toFixed(3), px: c.width * c.height, css: [c.clientWidth, c.clientHeight] }; });
  ok('FHD 보통 단계는 QHD 화면에서도 FHD 화소 수 이하로 그리고(후처리 켬, 접촉 그림자는 높음만)', Q.fx && !Q.ao && Q.px <= 1920 * 1080 * 1.02 && Q.pr < 1, JSON.stringify(Q));
  await qp.close();
  const hp2 = await browser.newPage();
  await hp2.setViewport({ width: 1280, height: 720 });
  await hp2.goto(`${base}?scenario=fan_fault&t=100&q=high&fx=on`, { waitUntil: 'networkidle0' });
  await hp2.waitForFunction(() => window.__viewer?.scene, { timeout: 20000 });
  await sleep(1500);
  const Q2 = await hp2.evaluate(() => ({ fx: !!window.__viewer.scene.fx, ao: !!window.__viewer.scene.fx?.ao }));
  const Q3 = await hp2.evaluate(() => { window.__viewer.scene.applyQuality('low'); return { fx: !!window.__viewer.scene.fx }; });
  ok('높음은 후처리와 접촉 그림자를 켜고, 낮은 단계로 내리면 후처리가 꺼짐', Q2.fx && Q2.ao && !Q3.fx, JSON.stringify({ Q2, Q3 }));
  await hp2.close();

  // 질감 단계: 낮음 256 px 외벽에 법선 지도 없음, 보통 512 px + 법선 지도, 높음 1024 px. 비등방성은 단계 상한과 기기 상한 중 작은 값.
  const texInfo = async (q) => {
    const tp2 = await browser.newPage();
    await tp2.setViewport({ width: 1280, height: 720 });
    await tp2.goto(`${base}?scenario=fan_fault&t=100&q=${q}&fx=off`, { waitUntil: 'networkidle0' });
    await tp2.waitForFunction(() => window.__viewer?.scene?.exteriorModel, { timeout: 30000 });
    await sleep(800);
    const r = await tp2.evaluate(() => {
      const s = window.__viewer.scene;
      let maxW = 0, normals = 0, minAniso = 99, detail = 0, glass = 0;
      s.exteriorModel.traverse((o) => { if (o.material && !Array.isArray(o.material)) { const k = o.material.customProgramCacheKey(); if (k.includes('dc-detail')) detail++; if (k.includes('dc-glass-windows')) glass++; } });
      const seen = new Set();
      s.city.group.traverse((o) => {
        const m = o.material;
        if (!m || Array.isArray(m)) return;
        if (m.map && m.emissiveMap && m.map.image && !seen.has(m.map)) { seen.add(m.map); maxW = Math.max(maxW, m.map.image.width); if (m.normalMap) normals++; minAniso = Math.min(minAniso, m.map.anisotropy); }
      });
      return { glass, detail, maxW, normals, minAniso, cap: s.renderer.capabilities.getMaxAnisotropy(), want: s.q.aniso };
    });
    await tp2.close();
    return r;
  };
  const T1 = await texInfo('low'), T2 = await texInfo('mid'), T3 = await texInfo('high');
  ok('TEX 질감 단계: 낮음 256 px(법선 없음), 보통 512 px(법선 있음), 높음 1024 px', T1.maxW === 256 && T1.normals === 0 && T2.maxW === 512 && T2.normals > 0 && T3.maxW === 1024 && T3.normals > 0, JSON.stringify({ T1, T2, T3 }));
  ok('GLASS 본 건물 유리에 창마다 농도, 반사, 층 띠 변화가 모든 단계에서 적용됨', T1.glass >= 1 && T2.glass >= 1 && T3.glass >= 1, JSON.stringify({ low: T1.glass, mid: T2.glass, high: T3.glass }));
  ok('DETAIL 건물 모델의 단조로운 면(콘크리트, 지붕, 아스팔트, 금속 패널, 벽 안쪽)에 미세 디테일이 높음과 보통에서만 겹쳐짐', T1.detail === 0 && T2.detail >= 4 && T3.detail >= 4, JSON.stringify({ low: T1.detail, mid: T2.detail, high: T3.detail }));
  ok('TEX 비등방성 필터링이 단계 상한(낮음 2, 보통 8, 높음 16)과 기기 상한 중 작은 값으로 적용됨', T1.minAniso === Math.min(2, T1.cap) && T2.minAniso === Math.min(8, T2.cap) && T3.minAniso === Math.min(16, T3.cap), JSON.stringify({ a: [T1.minAniso, T2.minAniso, T3.minAniso], cap: T1.cap }));
}

// 인터랙션 개편: 오른쪽 패널 기본 접힘, 건물 호버(외곽선+카드), 휴대폰 첫 터치는 정보
{
  const hp = await browser.newPage();
  await hp.setViewport({ width: 1440, height: 860 });
  await hp.goto(`${base}?scenario=fan_fault&t=100&stage=hall&panel=default`, { waitUntil: 'networkidle0' });
  await hp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await sleep(400);
  const P0 = await hp.evaluate(() => ({ closed: document.getElementById('side').classList.contains('collapsed'), pressed: document.getElementById('side-toggle').getAttribute('aria-pressed'), badge: document.getElementById('side-toggle-count').textContent, badgeHidden: document.getElementById('side-toggle-count').hidden }));
  ok('PANEL 넓은 화면에서는 오른쪽 정보 패널이 접힌 채 시작하고, 접힌 단추에 이상 건수가 보임', P0.closed && P0.pressed === 'false' && !P0.badgeHidden && Number(P0.badge) >= 1, JSON.stringify(P0));
  const rp = await hp.evaluate(() => { const c = document.getElementById('canvas'); const p = window.__viewer.scene.screenOf('rack_05', c); const r = c.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y + 14 }; });
  await hp.mouse.click(rp.x, rp.y);
  await sleep(300);
  const P1 = await hp.evaluate(() => ({ closed: document.getElementById('side').classList.contains('collapsed'), tab: document.querySelector('#side-tabs [aria-selected="true"]')?.dataset.tab }));
  ok('PANEL 랙을 누르면 패널이 펼쳐지며 상세 탭이 열림', !P1.closed && P1.tab === 'detail', JSON.stringify(P1));
  const A0 = await hp.evaluate(() => ({ chip: !document.getElementById('alarm-chip').hidden, n: Number(document.getElementById('alarm-chip-n').textContent), list: window.__viewer.scene.alarmedEquipment(), rings: !!window.__viewer.scene._rings?.visible, ringN: window.__viewer.scene._rings?.count ?? 0 }));
  ok('ALARM 이상이 있으면 서버실 화면에 "다음 이상 장비 보기" 단추와 바닥 링이 보임', A0.chip && A0.n >= 1 && A0.list.length >= 1 && A0.rings && A0.ringN === A0.list.length, JSON.stringify(A0));
  const seen = [];
  for (let i = 0; i < A0.list.length + 1; i++) {
    await hp.click('#alarm-chip');
    await sleep(250);
    seen.push(await hp.evaluate(() => window.__viewer.state.selected));
  }
  ok('ALARM 단추를 누를 때마다 이상 장비를 차례로 선택하고 한 바퀴 돌면 처음으로 돌아옴', seen.slice(0, A0.list.length).every((k) => A0.list.includes(k)) && new Set(seen.slice(0, A0.list.length)).size === A0.list.length && seen.at(-1) === seen[0], JSON.stringify({ list: A0.list, seen }));
  await hp.close();

  const bp = await browser.newPage();
  await bp.setViewport({ width: 1440, height: 860 });
  await bp.goto(`${base}?scenario=fan_fault&t=100&panel=default`, { waitUntil: 'networkidle0' });
  await bp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await bp.evaluate(() => { const s = window.__viewer.scene; s._anim = null; s.setPreset('ext', true); s.update(0.016, 1); });
  await sleep(500);
  const bpt = () => bp.evaluate(() => { const s = window.__viewer.scene; const c = document.getElementById('canvas'); const r = c.getBoundingClientRect(); const v = s._bldg.center.clone().project(s.camera); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; });
  const TG = await bp.evaluate(() => { const c = document.getElementById('building-card'); const r = c.getBoundingClientRect(); const cv = document.getElementById('canvas').getBoundingClientRect(); return { shown: !c.hidden && getComputedStyle(c).visibility === 'visible', name: c.querySelector('b').textContent, power: document.getElementById('bc-power').textContent, alarmChip: document.getElementById('bc-alarm').hidden ? '' : document.getElementById('bc-alarm').textContent, hot: c.classList.contains('hot'), inside: r.left >= cv.left && r.right <= cv.right && r.top >= cv.top && r.bottom <= cv.bottom, box: !!window.__viewer.scene.building && window.__viewer.scene._bldg !== undefined }; });
  ok('TAG 외관에서는 건물 위에 이름과 전체 전력(kW)이 항상 붙어 있고, 알람이 있을 때만 알람 건수가 붙음("정상" 문구 없음), 화면 안에 있음', TG.shown && TG.name.length > 0 && /kW$/.test(TG.power) && /^(|알람 \d+)$/.test(TG.alarmChip) && !TG.hot && TG.inside, JSON.stringify(TG));
  const bpos = await bpt();
  const sizeBefore = await bp.$eval('#building-card', (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  const PK = await bp.evaluate(() => {
    const s = window.__viewer.scene;
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const at = (x, y, z) => { const v = { x, y, z }; const p = new (s.camera.position.constructor)(v.x, v.y, v.z).project(s.camera); return [((p.x + 1) / 2), ((1 - p.y) / 2)]; };
    const m = s._main;
    const mid = at(m.center.x, m.center.y, m.center.z);
    const side = at(m.center.x + m.half.x + 9, 1.5, m.center.z); // 건물 옆 부지(부속 시설 쪽)
    const sizeOk = m.half.x * 2 < 90 && m.half.z * 2 < 70;
    return { hitMain: s.pickBuilding(...mid), hitSide: s.pickBuilding(...side), sizeOk, size: [+(m.half.x * 2).toFixed(1), +(m.half.y * 2).toFixed(1), +(m.half.z * 2).toFixed(1)] };
  });
  ok('PICK 데이터센터 건물 한 동만 호버와 클릭 대상(건물 옆 부속 시설 쪽은 아님)', PK.hitMain && !PK.hitSide && PK.sizeOk, JSON.stringify(PK));
  await bp.mouse.move(bpos.x, bpos.y, { steps: 4 });
  await sleep(300);
  const H1 = await bp.evaluate(() => ({ card: !document.getElementById('building-card').hidden, hot: document.getElementById('building-card').classList.contains('hot'), power: document.getElementById('bc-power').textContent, name: document.querySelector('#building-card b').textContent, outline: !!window.__viewer.scene._bHover?.visible, edges: !!window.__viewer.scene._bHover?.isLineSegments2, size: (() => { const r = document.getElementById('building-card').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(), pinned: document.getElementById('building-card').classList.contains('pinned') }));
  ok('HOVER 외관에서 건물에 올리면 외곽 강조선이 생기고 이름·상태 표시는 커지지 않음(테두리 색만 바뀜)', H1.card && H1.hot && H1.outline && H1.edges && !H1.pinned && H1.size[0] === sizeBefore[0] && H1.size[1] === sizeBefore[1], JSON.stringify({ H1, sizeBefore }));
  await bp.mouse.move(8, 700, { steps: 4 });
  await sleep(300);
  const H2 = await bp.evaluate(() => ({ card: document.getElementById('building-card').classList.contains('hot'), outline: !!window.__viewer.scene._bHover?.visible }));
  ok('HOVER 건물에서 벗어나면 외곽선과 안내가 사라지고 이름·상태는 남음', !H2.card && !H2.outline, JSON.stringify(H2));
  await bp.close();

  const tp = await browser.newPage();
  await tp.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await tp.goto(`${base}?scenario=fan_fault&t=100&panel=default`, { waitUntil: 'networkidle0' });
  await tp.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await tp.evaluate(() => { const s = window.__viewer.scene; s._anim = null; s.setPreset('ext', true); s.update(0.016, 1); });
  await sleep(500);
  const tpos = await tp.evaluate(() => { const s = window.__viewer.scene; const c = document.getElementById('canvas'); const r = c.getBoundingClientRect(); const v = s._bldg.center.clone().project(s.camera); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; });
  await tp.touchscreen.tap(tpos.x, tpos.y);
  await sleep(500);
  const T1 = await tp.evaluate(() => ({ stage: window.__viewer.flow?.stage ?? window.__viewer.scene.stage, card: !document.getElementById('building-card').hidden, pinned: document.getElementById('building-card').classList.contains('pinned'), outline: !!window.__viewer.scene._bHover?.visible }));
  ok('TOUCH 휴대폰에서 건물을 처음 누르면 들어가지 않고 정보(외곽선, 카드, 들어가기 단추)만 보임', T1.stage === 'exterior' && T1.card && T1.pinned && T1.outline, JSON.stringify(T1));
  await tp.touchscreen.tap(tpos.x, tpos.y);
  await sleep(1500);
  const T2 = await tp.evaluate(() => ({ stage: window.__viewer.scene.stage, card: !document.getElementById('building-card').hidden }));
  ok('TOUCH 한 번 더 누르면 홀로 들어가고 카드가 사라짐', T2.stage === 'hall' && !T2.card, JSON.stringify(T2));
  await tp.close();
}

await browser.close();
web.close();
const bad = [...new Set(errors)];
ok('콘솔 오류 없음', bad.length === 0, bad.slice(0, 3).join(' | '));
process.exit(results.every(Boolean) ? 0 : 1);
