// 기기별 화면 점검 (2026-11-11 사용자 요청: 갤럭시, 아이폰, 태블릿에서 UI가 화면 안에 다 보이는지).
// 기기 x 방향(세로, 가로) x 상태마다 (1) 가로 스크롤 (2) 화면 밖으로 일부라도 나간 글자·단추 (3) 떠 있는 UI끼리 겹침 (4) 너무 작은 누름 대상을 찾고 화면을 찍는다.
// 사용: npm run build 뒤 `node tools/device_check.mjs [출력 폴더]` (몇 분, 백그라운드로). 종료 코드 1이면 문제 있음. 화면은 출력 폴더에 저장(저장소에 올리지 않음).
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const OUT = process.argv[2] ?? null;
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
if (OUT) await mkdir(OUT, { recursive: true });

// CSS 화소(뷰포트) 기준. 브라우저 주소창이 차지하는 높이를 뺀 대략의 보이는 높이다.
export const DEVICES = [
  ['갤럭시 S24', 360, 740, 3],
  ['갤럭시 S24 울트라', 412, 860, 3.5],
  ['갤럭시 Z 폴드(접음)', 344, 820, 3],
  ['아이폰 SE', 375, 600, 2],
  ['아이폰 15', 393, 760, 3],
  ['아이폰 15 프로 맥스', 430, 840, 3],
  ['아이패드 미니', 744, 1060, 2],
  ['아이패드 에어', 820, 1110, 2],
  ['갤럭시 탭 S9', 800, 1200, 2],
  ['아이패드 프로 12.9', 1024, 1300, 2],
];

const STATES = [
  ['외관', async () => {}],
  ['홀-모니터링', async (pg) => { await pg.$eval('#enter-btn', (e) => e.click()); await sleep(1000); }],
  ['홀-정보 시트', async (pg) => { await pg.evaluate(() => { const h = document.getElementById('sheet-handle'); if (h && getComputedStyle(h).display !== 'none') h.click(); else document.getElementById('side-toggle')?.click(); }); await sleep(700); }],
  ['홀-시뮬레이션', async (pg) => { await pg.$eval('#rail [data-mode="lib"]', (e) => e.click()); await sleep(1000); }],
  ['홀-간이 계산', async (pg) => { await pg.$eval('#rail [data-mode="sim"]', (e) => e.click()); await sleep(1000); }],
  ['홀-CCTV', async (pg) => { await pg.$eval('#rail [data-mode="cctv"], #cctv-btn', (e) => e.click()); await sleep(1000); }],
  ['도움말 창', async (pg) => { await pg.evaluate(() => document.querySelector('#rail [data-mode="rec"]')?.click()); await sleep(500); await pg.evaluate(() => document.getElementById('help-btn')?.click()); await sleep(500); }],
  ['서버 연결 창', async (pg) => { await pg.evaluate(() => { document.getElementById('help-dialog')?.close(); document.querySelector('[data-mode="server"]')?.click(); }); await sleep(500); }],
  ['조건 창', async (pg) => { await pg.evaluate(() => { document.getElementById('server-dialog')?.close(); window.__viewer?.jobs?.().ui?.open(); }); await sleep(500); }],
];

// 화면 밖, 겹침, 작은 누름 대상 (페이지 안에서 실행)
const AUDIT = () => {
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (let n = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  // 스크롤되는 칸 안의 요소는 그 칸까지만 본다(스크롤하면 보임)
  const scrollParent = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX)) return n;
    }
    return null;
  };
  const name = (el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase()) + (el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '') + ` "${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20)}"`;
  const out = { hscroll: document.documentElement.scrollWidth > vw + 1, off: [], overlap: [], small: [] };
  const open = document.querySelector('dialog[open]');
  const scope = open ?? document;
  const targets = scope.querySelectorAll('button, a[href], select, input:not([type=hidden]), [role=tab], h1, h2, h3, label, p, dt, dd, output, b, span.count');
  for (const el of targets) {
    if (!visible(el) || el.id === 'canvas') continue;
    if (open == null && el.closest('dialog')) continue;
    const r = el.getBoundingClientRect();
    const sp = scrollParent(el);
    const box = sp ? sp.getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh };
    const L = Math.max(box.left, 0), T = Math.max(box.top, 0), R = Math.min(box.right, vw), B = Math.min(box.bottom, vh);
    if (sp) { if (r.bottom <= T || r.top >= B) continue; } // 스크롤 칸 밖(위아래)은 스크롤하면 보인다
    const hs = sp && sp.scrollWidth > sp.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(sp).overflowX); // 가로로 밀어 보는 줄: 옆으로 나간 것은 밀면 보인다
    const cut = (!hs && (r.left < L - 1 || r.right > R + 1)) || (hs && (r.top < Math.max(0, box.top) - 1 || r.bottom > Math.min(vh, box.bottom) + 1)) || (!sp && (r.top < T - 1 || r.bottom > B + 1));
    if (cut) out.off.push(`${name(el)} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`);
    // 글자가 꺾여 단추가 세로로 길쭉해진 경우(한 줄 단추인데 높이가 글자 3줄 이상)
    if (el.matches('button, [role=tab]') && el.textContent.trim().length > 1 && parseFloat(getComputedStyle(el).fontSize) >= 6 && r.height > 3 * parseFloat(getComputedStyle(el).fontSize) * 1.4 && r.height > r.width) out.off.push(`${name(el)} 글자가 꺾임 ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (el.matches('button, select, input, [role=tab], a[href]') && (r.width < 28 || r.height < 28) && !el.matches('input[type=checkbox], input[type=radio], input[type=range]')) out.small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // 떠 있는 UI끼리 겹침(대화상자가 열려 있으면 보지 않음)
  if (!open) {
    const floats = ['#top', '#rail', '#stage-tools', '#mode-badge', '#legend', '#transport', '#alarm-chip', '#job-progress', '#exterior-card', '#side', '#sheet-handle', '#back-btn', '#split-bar'].map((s) => document.querySelector(s)).filter((e) => e && visible(e));
    for (let i = 0; i < floats.length; i++) {
      for (let j = i + 1; j < floats.length; j++) {
        const a = floats[i].getBoundingClientRect(), b = floats[j].getBoundingClientRect();
        if (floats[i].contains(floats[j]) || floats[j].contains(floats[i])) continue;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 4 && h > 4) out.overlap.push(`${floats[i].id} x ${floats[j].id} (${Math.round(w)}x${Math.round(h)})`);
      }
    }
  }
  return out;
};

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const lines = [];
for (const [dname, w0, h0, dpr] of DEVICES) {
  for (const land of [false, true]) {
    const [w, h] = land ? [h0, w0] : [w0, h0];
    const tag = `${dname} ${land ? '가로' : '세로'} ${w}x${h}`;
    const pg = await browser.newPage();
    await pg.setViewport({ width: w, height: h, deviceScaleFactor: Math.min(dpr, 2), isMobile: true, hasTouch: true, isLandscape: land });
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${base}?q=low&fx=off`, { waitUntil: 'networkidle0' });
    await pg.waitForFunction(() => window.__viewer?.state, { timeout: 30000 });
    await sleep(800);
    for (const [sname, enter] of STATES) {
      try {
        await enter(pg);
      } catch (e) {
        lines.push(`  ! ${tag} / ${sname}: 들어가지 못함 (${e.message.slice(0, 60)})`);
        continue;
      }
      const a = await pg.evaluate(AUDIT);
      const bad = a.hscroll || a.off.length || a.overlap.length;
      if (bad) problems.push({ tag, state: sname, ...a });
      lines.push(`${bad ? '문제' : '통과'}  ${tag} / ${sname}${a.hscroll ? ' [가로 스크롤]' : ''}${a.off.length ? ` 화면 밖 ${a.off.length}` : ''}${a.overlap.length ? ` 겹침 ${a.overlap.length}` : ''}${a.small.length ? ` (작은 누름 ${a.small.length})` : ''}`);
      for (const x of a.off.slice(0, 6)) lines.push(`      밖: ${x}`);
      for (const x of a.overlap.slice(0, 6)) lines.push(`      겹침: ${x}`);
      if (OUT) await pg.screenshot({ path: path.join(OUT, `${dname}_${land ? 'L' : 'P'}_${sname}.png`.replace(/[\s/]+/g, '_')) });
    }
    if (errs.length) { problems.push({ tag, state: '오류', errs }); lines.push(`  ! ${tag} 오류 ${errs.slice(0, 2).join(' | ')}`); }
    await pg.close();
  }
}
console.log(lines.join('\n'));
console.log(`\n점검 ${DEVICES.length * 2 * STATES.length}개 상태, 문제 ${problems.length}개`);
await browser.close();
web.close();
process.exit(problems.length ? 1 : 0);
