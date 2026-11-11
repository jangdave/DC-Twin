// 누를 수 있는 요소 전수 점검: 상태 x 화면 크기마다 (1) 화면 밖/가려짐/너무 작음 (2) 눌러도 아무 변화가 없는 버튼을 찾는다.
// 사용: npm run build 뒤 `node tools/interact_check.mjs` (몇 분 걸리므로 백그라운드로). 종료 코드 1이면 문제 있음.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const web = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(p === '/' ? 'x.html' : p)] ?? 'application/octet-stream' }).end(await readFile(path.join(DIST, p === '/' ? 'index.html' : p))); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

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

const VIEWS = [['PC', 1440, 860, false], ['모바일', 390, 844, true]];
const STATES = [
  ['바깥', async () => {}],
  ['홀-모니터링', async (pg) => { await pg.$eval('#enter-btn', (e) => e.click()); await sleep(900); }],
  ['홀-시뮬레이션', async (pg) => { await pg.$eval('#rail [data-mode="lib"]', (e) => e.click()); await sleep(900); }],
  ['홀-간이 계산', async (pg) => { await pg.$eval('#rail [data-mode="sim"]', (e) => e.click()); await sleep(900); }],
  ['홀-CCTV', async (pg) => { await pg.$eval('#cctv-btn', (e) => e.click()); await sleep(900); }],
];

// 보이는 누름 대상 목록 (페이지 안에서 실행)
const COLLECT = () => {
  const sel = 'button, a[href], select, input:not([type=hidden]), summary, [role=button], [role=tab], [tabindex]:not([tabindex="-1"])';
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
    let hidden = false;
    for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) { hidden = true; break; } if (n.hidden) { hidden = true; break; } }
    if (hidden) continue;
    if (el.id === 'canvas') continue; // CCTV 화면에서는 3D 캔버스가 뒤에 깔리는 것이 정상
    let clipped = false; // 스크롤되는 칸 안에서 아직 안 보이는 요소(스크롤하면 보임)는 건너뜀
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll|hidden)/.test(s.overflowY + s.overflowX)) { const pr = n.getBoundingClientRect(); if (r.bottom > pr.bottom + 1 || r.top < pr.top - 1) { clipped = true; break; } if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(s.overflowX) && (r.right > pr.right + 1 || r.left < pr.left - 1)) { clipped = true; break; } } } // 가로로 밀어 보는 줄(보기 도구, 탭)은 밀면 보인다
    if (clipped) continue;
    const label = (el.getAttribute('aria-label') || el.textContent || el.title || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 24);
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    const covered = !(top && (top === el || el.contains(top) || top.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(top)))));
    const offscreen = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
    const partlyOff = !offscreen && (r.left < -1 || r.right > innerWidth + 1);
    out.push({ label, id: el.id, tag: el.tagName, type: el.type || '', w: Math.round(r.width), h: Math.round(r.height), x: Math.round(cx), y: Math.round(cy), covered, coveredBy: covered && top ? (top.id || top.className || top.tagName).toString().slice(0, 30) : '', offscreen, partlyOff, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
  }
  return out;
};
const SNAP = () => {
  const v = window.__viewer;
  const attrs = [...document.querySelectorAll('[aria-pressed],[aria-selected],[aria-expanded],.active,.on,dialog,[hidden]')].map((e) => `${e.id}|${e.className}|${e.getAttribute('aria-pressed')}|${e.getAttribute('aria-selected')}|${e.hidden}|${e.open ?? ''}`).join(';');
  const cam = v?.camera ? [...v.camera.position.toArray(), ...(v.controls?.target?.toArray?.() ?? [])].map((n) => n.toFixed(2)).join(',') : '';
  return `${document.body.innerText.length}|${document.body.innerText.slice(0, 600)}|${attrs}|${cam}|${location.href}|${[...document.querySelectorAll('select,input')].map((e) => e.value + e.checked).join(',')}`;
};

const problems = [];
const warn = [];
let checked = 0;
for (const [vname, w, h, touch] of VIEWS) {
  for (const [sname, enter] of STATES) {
    const pg = await browser.newPage();
    await pg.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch });
    await pg.goto(`${base}?scenario=fan_fault&t=100`, { waitUntil: 'networkidle0' });
    await pg.waitForFunction(() => window.__viewer?.state.player, { timeout: 20000 });
    await pg.evaluate(() => (window.__viewer.state.player.playing = false));
    pg.on('dialog', (d) => d.dismiss());
    if (sname !== '바깥') await pg.$eval('#enter-btn', (e) => e.click()), await sleep(700);
    await enter(pg);
    await sleep(500);
    const items = await pg.evaluate(COLLECT);
    const minSide = touch ? 32 : 22;
    for (const it of items) {
      checked++;
      const tag = `[${vname}/${sname}] ${it.tag.toLowerCase()}#${it.id || '-'} "${it.label}"`;
      if (it.covered) problems.push(`${tag}: 다른 요소(${it.coveredBy})가 가려서 눌리지 않음 (${it.x},${it.y})`);
      if (it.offscreen) problems.push(`${tag}: 화면 밖에 있음`);
      else if (it.partlyOff) warn.push(`${tag}: 가로로 일부 잘림`);
      if (!['range', 'checkbox', 'radio'].includes(it.type) && (it.w < minSide || it.h < minSide) && it.tag !== 'SELECT' ) warn.push(`${tag}: 눌릴 면적이 작음 ${it.w}x${it.h}`);
    }
    // 눌러도 변화 없는 버튼: 같은 쪽에서 차례로 누르고, 의심되는 것만 새 쪽에서 다시 확인한다
    const keys = items.filter((i) => i.tag === 'BUTTON' && !i.disabled && !i.covered && !i.offscreen).map((i) => `${i.id}|${i.label}`);
    const suspects = [];
    for (const key of keys) {
      const cur = (await pg.evaluate(COLLECT)).find((i) => `${i.id}|${i.label}` === key && i.tag === 'BUTTON' && !i.covered && !i.offscreen);
      if (!cur) continue;
      const before = await pg.evaluate(SNAP);
      try { await pg.mouse.click(cur.x, cur.y); } catch { continue; }
      await sleep(250);
      if (before === (await pg.evaluate(SNAP))) suspects.push(key);
    }
    await pg.close();
    for (const key of suspects) {
      const np = await browser.newPage();
      await np.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch });
      np.on('dialog', (d) => d.dismiss());
      await np.goto(`${base}?scenario=fan_fault&t=100`, { waitUntil: 'networkidle0' });
      await np.waitForFunction(() => window.__viewer?.state.player, { timeout: 20000 });
      await np.evaluate(() => (window.__viewer.state.player.playing = false));
      if (sname !== '바깥') await np.$eval('#enter-btn', (e) => e.click()), await sleep(700);
      await enter(np); await sleep(500);
      const cur = (await np.evaluate(COLLECT)).find((i) => `${i.id}|${i.label}` === key && i.tag === 'BUTTON');
      if (cur) {
        const before = await np.evaluate(SNAP);
        await np.mouse.click(cur.x, cur.y); await sleep(300);
        const after = await np.evaluate(SNAP);
        const pressed = await np.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y)?.closest('button'); return !!e && (e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' || e.classList.contains('active') || e.classList.contains('on')); }, [cur.x, cur.y]);
        if (before === after && !pressed) problems.push(`[${vname}/${sname}] button#${cur.id || '-'} "${cur.label}": 눌러도 아무 변화가 없음`);
      }
      await np.close();
    }
  }
}
await browser.close();
web.close();
console.log(`점검한 요소 ${checked}개`);
const uniq = (a) => [...new Set(a)];
if (warn.length) console.log(`\n주의 ${uniq(warn).length}건\n` + uniq(warn).map((s) => '  - ' + s).join('\n'));
if (problems.length) { console.log(`\n문제 ${uniq(problems).length}건\n` + uniq(problems).map((s) => '  - ' + s).join('\n')); process.exit(1); }
console.log('문제 없음');
