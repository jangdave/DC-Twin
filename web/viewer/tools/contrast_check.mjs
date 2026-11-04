// 글자색 전수조사: 모든 화면 상태를 돌며 보이는 글자의 대비(글자색과 실제 배경색의 밝기 비)를 잰다.
//   npm run build && node tools/contrast_check.mjs [--browser 경로] [--list]
// 기준: 일반 글자 4.5 이상, 큰 글자(24px 이상, 굵으면 18.7px 이상) 3 이상. 못 미치면 실패로 센다.
// 3D 화면 위에 바로 놓인 글자는 배경을 알 수 없어 어두운 장면(#0d1117)으로 가정한다.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
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

// 화면 안에서 도는 측정 함수
const AUDIT = (only) => {
  const SCENE_BG = [13, 17, 23, 1];
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const over = (top, bot) => {
    const a = top[3] + bot[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let bg = [0, 0, 0, 0];
    for (const e of chain) {
      const cs = getComputedStyle(e);
      const c = parse(cs.backgroundColor);
      bg = over(bg, c); // 위(자식)에 아래(조상)를 깐다
      if (bg[3] >= 0.999) return bg;
    }
    return over(bg, SCENE_BG);
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const visible = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const out = [];
  const measure = (el, text, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    const bg = bgOf(el);
    let fg = parse(cs.color);
    fg = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r >= need) return;
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    out.push({ sel: `${el.tagName.toLowerCase()}${id}${cls}${pseudo ?? ''}`, text: String(text).slice(0, 24), ratio: Number(r.toFixed(2)), need, disabled: el.closest('[disabled], [aria-disabled="true"]') !== null, color: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})` });
  };
  // 입력칸, 선택 상자(글자는 텍스트 노드가 아니라 값이다)와 안내 글자
  for (const el of document.querySelectorAll('input:not([type=range]):not([type=radio]):not([type=checkbox]), select, textarea')) {
    if (!visible(el)) continue;
    if (el.tagName === 'SELECT') measure(el, el.selectedOptions[0]?.textContent ?? '');
    else if (el.value) measure(el, el.value);
    if (el.placeholder) measure(el, el.placeholder, '::placeholder');
  }
  const walker = document.createTreeWalker(only ?? document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || seen.has(el) || ['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    measure(el, t);
  }
  return out;
};


const AUDIT_SRC = AUDIT.toString();
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const findings = [];
let scanned = 0;
async function scan(page, label) {
  await sleep(350);
  const r = await page.evaluate(AUDIT);
  scanned++;
  for (const f of r) findings.push({ state: label, ...f });
  console.log(`${r.filter((x) => !x.disabled).length === 0 ? '통과' : '실패'}  ${label} (낮은 대비 ${r.filter((x) => !x.disabled).length}곳${r.some((x) => x.disabled) ? `, 비활성 ${r.filter((x) => x.disabled).length}곳 제외` : ''})`);
}
const click = (page, sel) => page.$eval(sel, (e) => e.click());
const tab = (page, name) => click(page, `#side-tabs [data-tab="${name}"]`);

// 마우스를 올리면 색이 바뀌는 단추도 보여야 한다: 보이는 단추마다 올려 보고 그 단추만 다시 잰다
async function hoverSweep(page, tag) {
  for (const [label, prep] of [['모니터링', null], ['시뮬레이션', '#rail [data-mode="sim"]']]) {
    if (prep) await click(page, prep);
    await sleep(400);
    const sels = await page.evaluate(() => {
      const list = [];
      document.querySelectorAll('button, [role="tab"], select, .cctv-tile').forEach((b, i) => {
        const r = b.getBoundingClientRect();
        if (r.width > 4 && r.height > 4 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(b).visibility !== 'hidden') {
          b.setAttribute('data-hv', String(i));
          list.push(`[data-hv="${i}"]`);
        }
      });
      return list;
    });
    for (const sel of sels) {
      await page.hover(sel).catch(() => {});
      const r = await page.evaluate((q) => {
        const e = document.querySelector(q);
        return e ? window.__audit(e) : [];
      }, sel);
      for (const f of r) findings.push({ state: `${tag} ${label} 마우스 올림`, ...f });
    }
    scanned++;
    console.log(`확인  ${tag} ${label} 마우스 올림 단추 ${sels.length}개`);
  }
}
async function suite(width, height, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: width < 700 });
  await page.evaluateOnNewDocument((src) => { window.__audit = (e) => new Function(`return (${src})`)()(e); }, AUDIT_SRC);
  await page.goto(`${base}?scenario=fan_fault&t=100`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__viewer?.state.player, { timeout: 15000 });
  await page.evaluate(() => (window.__viewer.state.player.playing = false));
  await scan(page, `${tag} 외관`);
  await click(page, '#enter-btn');
  await sleep(900);
  await scan(page, `${tag} 서버실 모니터링`);
  if (width < 900) await click(page, '#sheet-handle');
  for (const t of ['summary', 'detail', 'alarms']) {
    if (await page.$(`#side-tabs [data-tab="${t}"]`)) {
      await tab(page, t);
      await scan(page, `${tag} 패널 ${t}`);
    }
  }
  await page.evaluate(() => window.__viewer.selectEquipment('rack_05', true));
  await scan(page, `${tag} 랙 선택`);
  await click(page, '#heat-btn');
  await scan(page, `${tag} 온도 색칠`);
  await click(page, '#timeline-btn');
  await scan(page, `${tag} 기록 재생 막대`);
  await click(page, '#rail [data-mode="sim"]');
  await sleep(500);
  for (const t of ['control', 'energy', 'prep']) {
    await tab(page, t);
    await scan(page, `${tag} 시뮬레이션 ${t}`);
  }
  await click(page, '#cctv-btn');
  await sleep(500);
  await scan(page, `${tag} CCTV`);
  await click(page, '#cctv-btn');
  await click(page, '#help-btn');
  await scan(page, `${tag} 도움말`);
  await page.keyboard.press('Escape');
  await click(page, '#rail [data-mode="rec"]');
  await sleep(300);
  await click(page, '[data-mode="server"]');
  await scan(page, `${tag} 서버 연결 대화상자`);
  await page.keyboard.press('Escape');
  if (width >= 900) await hoverSweep(page, tag);
  await page.close();
}
await suite(1440, 860, '[PC]');
await suite(390, 800, '[휴대폰]');
await browser.close();
web.close();

const real = findings.filter((f) => !f.disabled);
const groups = new Map();
for (const f of real) {
  const k = `${f.sel} | ${f.color} on ${f.bg}`;
  const g = groups.get(k) ?? { ...f, states: new Set() };
  g.states.add(f.state);
  groups.set(k, g);
}
if (groups.size) console.log('\n낮은 대비 글자 (요소 | 글자색 on 배경 → 대비, 보이는 화면)');
for (const g of groups.values()) console.log(`  ${g.sel} "${g.text}" ${g.color} on ${g.bg} → ${g.ratio} (필요 ${g.need})  [${[...g.states].join(', ')}]`);
console.log(`\n화면 상태 ${scanned}개 점검, 낮은 대비 요소 ${groups.size}종`);
process.exit(groups.size ? 1 : 0);
