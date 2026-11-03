// 빌드 결과의 용량 기준을 점검한다 (docs/18 6.1장). 첫 로딩(모델과 속도장 제외)의 gzip 합이 1.5 MB 이하, 모델과 속도장까지 3 MB 이하여야 한다.
//   node tools/check_size.mjs [dist 폴더]
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] ?? path.join(HERE, '../dist'));
const FIRST_LOAD_LIMIT = 1.5 * 1024 * 1024;
const WITH_MODELS_LIMIT = 3 * 1024 * 1024; // 화면이 뜬 뒤 따로 받는 모델(models/)과 속도장(flow.bin)까지 합친 한도
const SCENARIO_LIMIT = 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = await walk(DIST);
const sizes = new Map();
for (const f of files) sizes.set(path.relative(DIST, f).replace(/\\/g, '/'), gzipSync(await readFile(f)).length);

// 첫 로딩: 화면 코드(assets/*, index.html), 장면, 센서 목록, 시나리오 목록, 처음에 보이는 시나리오(normal)
const later = (k) => k.startsWith('models/') || k === 'data/flow.bin'; // 화면이 뜬 뒤에 받는 파일
const all = [...sizes].filter(([k]) => !k.startsWith('data/rec/') || k === 'data/rec/normal.json');
const first = all.filter(([k]) => !later(k));
const allTotal = all.reduce((a, [, v]) => a + v, 0);
const firstTotal = first.reduce((a, [, v]) => a + v, 0);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const [k, v] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${kb(v).padStart(10)}  ${k}`);
console.log(`첫 로딩(gzip): ${kb(firstTotal)} (한도 ${kb(FIRST_LOAD_LIMIT)}), 모델과 속도장까지: ${kb(allTotal)} (한도 ${kb(WITH_MODELS_LIMIT)})`);
let bad = false;
if (allTotal > WITH_MODELS_LIMIT) {
  console.error('모델과 속도장까지 합친 용량이 한도를 넘었다');
  process.exitCode = 1;
}
if (firstTotal > FIRST_LOAD_LIMIT) {
  console.error('첫 로딩 용량이 한도를 넘었다');
  bad = true;
}
for (const [k, v] of sizes) {
  if (k.startsWith('data/rec/') && v > SCENARIO_LIMIT) {
    console.error(`${k}: 시나리오 파일이 한도(${kb(SCENARIO_LIMIT)})를 넘었다 (${kb(v)})`);
    bad = true;
  }
}
// 외부 주소로 가는 요청이 없는지(6.4장): 빌드 결과에서 http(s):// 참조를 찾는다
const risky = [];
for (const f of files.filter((f) => /\.(html|js|css)$/.test(f))) {
  const text = await readFile(f, 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
    if (!/w3\.org|threejs\.org|github\.com\/mrdoob/.test(m[0])) risky.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
  }
}
if (risky.length) {
  console.warn(`외부 주소 문자열 ${risky.length}개(실제 요청인지 확인할 것):`);
  for (const r of [...new Set(risky)].slice(0, 10)) console.warn(`  ${r}`);
}
await stat(DIST);
process.exit(bad ? 1 : 0);
