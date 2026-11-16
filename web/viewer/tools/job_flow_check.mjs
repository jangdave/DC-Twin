// 실제 서버로 정확한 계산 결과의 공기 흐름(job_flow)을 웹이 받아 그리는지 확인한다(docs/31 7장). 서버가 떠 있어야 한다.
// 사용(빌드 뒤): node tools/job_flow_check.mjs --server ws://127.0.0.1:8765/ws --job <작업 id>
// 확인: 결과를 열면 작업 흐름을 쓰고(scene.usingJobFlow), 재생 중 팬 상태에 맞는 장을 고르며, 모니터링으로 돌아가면 미리 계산한 흐름으로 돌아간다.
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
const server = arg('--server', 'ws://127.0.0.1:8765/ws');
const job = arg('--job', '');
if (!job) throw new Error('--job <작업 id>가 필요하다');
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
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
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '통과' : '실패'}  ${name} ${extra}`);
};
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'warning' && console.log('  [경고]', m.text()));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${web.address().port}/?stage=hall&server=${encodeURIComponent(server)}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__viewer?.scene?.airflow && window.__viewer.jobs().client?.state === 'open', { timeout: 60000 });
  await page.evaluate(() => document.querySelector('#rail [data-mode="lib"]').click());
  await page.waitForFunction(() => window.__viewer.sourcesSettled(), { timeout: 20000 });
  ok('처음에는 미리 계산한 흐름', !(await page.evaluate(() => window.__viewer.scene.usingJobFlow)));
  await page.evaluate((id) => window.__viewer.jobs().client.result(id), job);
  const got = await page.waitForFunction(() => window.__viewer.scene.usingJobFlow, { timeout: 60000 }).then(() => true, () => false);
  const st = await page.evaluate(() => {
    const v = window.__viewer;
    const a = v.scene.airflow;
    return { mode: v.state.mode, badge: document.getElementById('mode-badge').textContent, seq: a.seq, fields: a.seqFans?.length, field: a.field, title: document.getElementById('flow-btn').title };
  });
  ok('결과를 열면 이 작업의 OpenFOAM 흐름을 씀', got && st.seq && st.badge.includes('서버 계산 결과'), JSON.stringify(st));
  // 공기 흐름을 켜고 고장 뒤 시각으로 옮기면 그 팬 상태의 장을 고른다
  await page.evaluate(() => { const b = document.getElementById('flow-btn'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); });
  const nf = st.fields ?? 0;
  if (nf > 1) {
    await page.evaluate(() => { const pl = window.__viewer.state.player; pl.playing = false; pl.seek(Math.min(200, pl.duration - 1)); }); // 고장(60초) 뒤. 반복 재생으로 처음으로 돌아가지 않게 멈춘다
    const moved = await page.waitForFunction(() => window.__viewer.scene.airflow.field > 0, { timeout: 15000 }).then(() => true, () => false);
    ok('고장 뒤로 옮기면 그 팬 상태의 장으로 바뀜', moved, JSON.stringify(await page.evaluate(() => { const v = window.__viewer; const a = v.scene.airflow; return { field: a.field, fan: a.fan, t: v.state.player?.time, dur: v.state.player?.duration, crac02: v.store.metric('crac_02', 'fan_speed')?.value, vis: a.points.visible, stage: v.scene.stage }; })));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(OUT, 'job_flow.png') });
  await page.evaluate(() => document.querySelector('#rail [data-mode="rec"]').click());
  await page.waitForFunction(() => window.__viewer.sourcesSettled(), { timeout: 20000 });
  const back = await page.waitForFunction(() => !window.__viewer.scene.usingJobFlow, { timeout: 10000 }).then(() => true, () => false);
  ok('모니터링으로 가면 미리 계산한 흐름으로 돌아감', back);
} finally {
  await browser.close();
  web.close();
}
process.exit(failed ? 1 : 0);
