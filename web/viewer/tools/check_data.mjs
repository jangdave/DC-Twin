// 데이터 정합성 점검: 장면, 센서, 녹화, 흐름 자료, 시뮬레이션 설정이 서로 맞는지 전수 확인한다.
//   node tools/check_data.mjs          (원본이 저장소에 있으면 다시 만들어 웹 자료와 같은지도 본다)
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '../public/data');
const ROOT = path.resolve(HERE, '../../..');
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '통과' : '실패'}  ${name} ${cond ? '' : extra}`);
};
const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);

const core = await import(pathToFileURL(path.join(HERE, '../src/sim/core.js')).href);
const insight = await import(pathToFileURL(path.join(HERE, '../src/sim/insight.js')).href);
const scene = await json(path.join(DATA, 'scene.json'));
const sensors = await json(path.join(DATA, 'sensors.json'));
const index = await json(path.join(DATA, 'index.json'));
const flow = await json(path.join(DATA, 'flow.json'));

// ---- 1. 장면 ----
const racks = scene.racks.map((r) => r.name);
const cracs = scene.cracs.map((c) => c.name);
ok('장면: 랙 이름이 겹치지 않음', dup(racks).length === 0, dup(racks).join());
ok('장면: 랙 60기, 6줄 x 10기', racks.length === 60 && new Set(scene.racks.map((r) => r.row)).size === 6 && [1, 2, 3, 4, 5, 6].every((n) => scene.racks.filter((r) => r.row === n).length === 10), `${racks.length}기`);
ok('장면: 냉각 장치 8기', cracs.length === 8, `${cracs.length}기`);
const boxes = [...scene.racks, ...scene.cracs];
ok('장면: 모든 상자가 min < max이고 홀 안에 있음', boxes.every((b) => b.min.every((v, i) => v < b.max[i]) && b.min[0] >= -1 && b.min[1] >= -1 && b.max[0] <= scene.size[0] + 1 && b.max[1] <= scene.size[1] + 1), '');
const overlap = (a, b) => a.min.every((v, i) => v < b.max[i] - 0.5 && b.min[i] < a.max[i] - 0.5);
let ov = 0;
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) ov++;
ok('장면: 랙과 냉각 장치가 서로 겹치지 않음', ov === 0, `${ov}쌍 겹침`);
const cfg = await json(path.join(ROOT, 'usd/scenes/hall01.config.json')).catch(() => null);
if (cfg) ok('원본 설정(hall01.config.json)의 줄 수와 줄당 랙 수가 장면과 같음', cfg.rows.count === 6 && cfg.rows.racks_per_row * cfg.rows.count === racks.length, `${cfg.rows.count} x ${cfg.rows.racks_per_row}`);

// ---- 2. 센서 ----
const eq = new Set([...racks.map((n) => n.toLowerCase()), ...cracs.map((n) => n.toLowerCase())]);
ok('센서: sensorId가 겹치지 않음', dup(sensors.map((s) => s.sensorId)).length === 0, dup(sensors.map((s) => s.sensorId)).join());
const orphan = sensors.filter((s) => !eq.has(s.equipment));
ok('센서: 모든 센서의 장비가 장면에 있음', orphan.length === 0, orphan.slice(0, 3).map((s) => s.sensorId).join());
ok('센서: 범위가 min < max이고 단위가 있음', sensors.every((s) => Array.isArray(s.range) && s.range[0] < s.range[1] && s.unit), '');
const thrBad = sensors.filter((s) => s.warn !== null && s.critical !== null && (s.direction === 'low' ? !(s.warn > s.critical) : !(s.warn < s.critical)));
ok('센서: 주의 기준과 위험 기준의 순서가 방향과 맞음', thrBad.length === 0, thrBad.slice(0, 3).map((s) => s.sensorId).join());
const rackMetrics = new Set(sensors.filter((s) => s.equipmentType === 'rack').map((s) => s.metric));
const perRack = racks.map((r) => sensors.filter((s) => s.equipment === r.toLowerCase()).length);
ok(`센서: 랙마다 같은 수(${perRack[0]}개)의 센서가 있음`, new Set(perRack).size === 1, [...new Set(perRack)].join());
const perCrac = cracs.map((r) => sensors.filter((s) => s.equipment === r.toLowerCase()).length);
ok(`센서: 냉각 장치마다 같은 수(${perCrac[0]}개)의 센서가 있음`, new Set(perCrac).size === 1, [...new Set(perCrac)].join());
console.log(`      (랙 지표: ${[...rackMetrics].join(', ')} / 센서 ${sensors.length}개)`);

// ---- 3. 녹화 ----
const byId = new Map(sensors.map((s) => [s.sensorId, s]));
const fileOf = (it) => it.file ?? it.id; // alias 항목(예: 급기 18도)은 다른 항목의 녹화 파일을 가리킨다
ok('시나리오 목록과 녹화 파일이 같음', JSON.stringify((await readdir(path.join(DATA, 'rec'))).sort()) === JSON.stringify([...new Set(index.map((i) => `${fileOf(i)}.json`))].sort()), '');
const recOf = new Map();
for (const it of index.filter((x) => !x.file)) {
  const r = await json(path.join(DATA, 'rec', `${it.id}.json`));
  recOf.set(it.id, r);
  const tag = `녹화 ${it.id}`;
  ok(`${tag}: 길이가 목록(${it.n})과 같고 모든 값 배열이 같은 길이`, r.n === it.n && Object.values(r.values).every((v) => v.length === r.n), '');
  const ids = Object.keys(r.values);
  const unknown = ids.filter((id) => !byId.has(id));
  ok(`${tag}: 값의 센서가 모두 센서 목록에 있음`, unknown.length === 0, unknown.slice(0, 3).join());
  ok(`${tag}: 센서 목록 ${sensors.length}개가 모두 값을 가짐`, ids.length === sensors.length, `${ids.length}개`);
  let nulls = 0, outOfRange = 0, total = 0;
  for (const [id, arr] of Object.entries(r.values)) {
    const s = byId.get(id);
    if (!s) continue;
    const span = s.range[1] - s.range[0];
    for (const v of arr) {
      total++;
      if (v === null || !Number.isFinite(v)) nulls++;
      else if (v < s.range[0] - span * 0.05 || v > s.range[1] + span * 0.05) outOfRange++;
    }
  }
  ok(`${tag}: 비어 있는 값 없음`, nulls === 0, `${nulls}/${total}`);
  ok(`${tag}: 센서 범위(5% 여유)를 벗어난 값 없음`, outOfRange === 0, `${outOfRange}/${total}`);
  const a = r.aggregates;
  let aggErr = 0;
  for (let i = 0; i < r.n; i++) {
    if (Math.abs(a.it_power[i] * (1 + core.DEFAULT_CONFIG.loss_ratio) + a.cooling_power[i] - a.facility_power[i]) > 0.5) aggErr++;
    if (Math.abs(a.facility_power[i] / a.it_power[i] - a.pue[i]) > 0.01) aggErr++;
  }
  ok(`${tag}: 설비 전력 = IT x (1 + 손실 비율) + 냉각, PUE = 설비 / IT`, aggErr === 0, `${aggErr}곳 어긋남`);
  const kwh = a.energy_kwh;
  ok(`${tag}: 누적 전력량이 줄지 않음`, kwh.every((v, i) => i === 0 || v >= kwh[i - 1] - 1e-9), '');
  ok(`${tag}: 알람이 시간 순서이고 센서가 목록에 있고 상태 이름이 맞음`, r.alarms.every((x, i) => (i === 0 || x.t >= r.alarms[i - 1].t) && byId.has(x.sensorId) && ['normal', 'warn', 'critical'].includes(x.to) && x.t >= 0 && x.t < r.n), '');
  const rackTemp = racks.map((n) => `H01-RK${n.split('_')[1]}-TEMP-IN`);
  const miss = rackTemp.filter((id) => !r.est[id]);
  ok(`${tag}: 보정 모델 값이 랙 60기 입구 온도에 모두 있고 길이가 맞음`, miss.length === 0 && Object.values(r.est).every((e) => e.lower.length === r.n && e.upper.length === r.n && e.conf.length === r.n && e.conf.every((c) => c >= 1 && c <= 4) && e.lower.every((v, i) => v <= e.upper[i])), miss.slice(0, 3).join());
  const known = new Set(cracs.map((c) => c.toLowerCase()).concat(racks.map((c) => c.toLowerCase())));
  ok(`${tag}: 사건의 대상이 장비 이름이거나 줄(row:N)`, (r.events ?? []).every((e) => known.has(e.target) || /^row:0?[1-6]$/.test(e.target)), JSON.stringify((r.events ?? []).filter((e) => !known.has(e.target) && !/^row:0?[1-6]$/.test(e.target))));
}

// ---- 4. 흐름 자료 ----
const cells = flow.shape.reduce((p, q) => p * q, 1);
const { size } = await (await import('node:fs/promises')).stat(path.join(DATA, 'flow.bin'));
ok(`흐름 자료: flow.bin 크기가 칸 수 x 3 x 필드 수와 같음 (${flow.fields.length}개)`, size === cells * 3 * flow.fields.length, `${size} vs ${cells * 3 * flow.fields.length}`);
ok('흐름 자료: 칸 크기와 모양이 홀 크기를 덮음', flow.shape[0] * flow.cell_m * 100 >= scene.size[0] - 1 && flow.shape[1] * flow.cell_m * 100 >= scene.size[1] - 1, `${flow.shape} x ${flow.cell_m}m vs ${scene.size}`);
ok('흐름 자료: 시각화 목적 문구가 있음', /시각화/.test(flow.note ?? ''), '');

// ---- 5. 시뮬레이션 설정과 화면 안내 ----

const simIds = Object.keys(core.SCENARIOS);
ok('시나리오: 시뮬레이션 엔진의 이름이 "이상 상황" 녹화와 같음', JSON.stringify([...simIds].sort()) === JSON.stringify(index.filter((i) => i.group === 'event').map((i) => i.id).sort()), simIds.join());
ok('시나리오: 모두 대응 순서 안내가 있음', simIds.every((k) => insight.RESPONSE[k]), '');
const warnIn = sensors.find((s) => s.metric === 'temp_in')?.warn;
ok(`센서: 입구 온도 주의 기준(${warnIn})이 화면의 기본값(${insight.WARN_IN_DEFAULT})과 같음`, warnIn === insight.WARN_IN_DEFAULT, '');
const rated = Math.max(...sensors.filter((s) => s.metric === 'power' && s.equipmentType === 'rack').map((s) => s.range[1]));
console.log(`      (랙 전력 센서 범위 최대 ${rated} kW, 화면 정격 가정 ${insight.RATED_KW} kW)`);

// ---- 5-1. 미리 계산한 상태 모음(라이브러리) ----
const lib = await json(path.join(DATA, 'library.json'));
const libDef = await json(path.join(ROOT, 'sim/library.json')).catch(() => null);
ok('라이브러리: 모든 항목의 그룹이 library.json에 있고 alias 대상이 있음', index.every((i) => lib.groups.some((g) => g.id === i.group) && (!i.file || index.some((x) => x.id === i.file && !x.file))), '');
if (libDef) ok('라이브러리: 정의(sim/library.json)와 웹 목록의 항목이 같음', JSON.stringify(libDef.entries.map((e) => e.id).sort()) === JSON.stringify(index.map((i) => i.id).sort()), '');
{
  const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const last = (r, name) => r.aggregates[name][r.n - 1];
  const maxIn = (r) => Math.max(...racks.map((n) => r.values[`H01-RK${n.split('_')[1]}-TEMP-IN`][r.n - 1]));
  const rec = (id) => recOf.get(index.find((i) => i.id === id).file ?? id);
  const sup = index.filter((i) => i.group === 'supply').sort((a, b) => a.value - b.value);
  const cool = sup.map((i) => last(rec(i.id), 'cooling_power'));
  const tin = sup.map((i) => maxIn(rec(i.id)));
  ok('라이브러리: 급기 온도가 오를수록 냉각 전력은 줄고 가장 높은 입구 온도는 오른다', cool.every((v, i) => i === 0 || v < cool[i - 1]) && tin.every((v, i) => i === 0 || v > tin[i - 1]), `냉각 ${cool.map((v) => v.toFixed(1))} 입구 ${tin.map((v) => v.toFixed(1))}`);
  const ld = index.filter((i) => i.group === 'load').sort((a, b) => a.value - b.value);
  const it = ld.map((i) => last(rec(i.id), 'it_power'));
  const fac = ld.map((i) => last(rec(i.id), 'facility_power'));
  ok('라이브러리: 부하가 오를수록 IT 전력과 설비 전력이 늘고 IT 전력은 기준 대비 비율에 가깝다', it.every((v, i) => i === 0 || v > it[i - 1]) && fac.every((v, i) => i === 0 || v > fac[i - 1]) && ld.every((l, i) => Math.abs(it[i] / it[ld.findIndex((x) => x.value === 100)] - l.value / 100) < 0.03), `IT ${it.map((v) => v.toFixed(0))}`);
  void mean;
}

// 외부 CFD 도구(상용 포함)의 결과는 공개 자료에 들어가면 안 된다. 서버가 줄 때만 화면에 보인다(docs/04)
ok('공개 자료에 외부 솔버 결과 항목이나 표시가 없음', !index.some((i) => i.source === 'external' || i.group === 'external' || /^ext_/.test(i.id)) && !lib.groups.some((g) => g.id === 'external') && [...recOf.values()].every((r) => r.meta?.source !== 'external'), '');

// ---- 5-2. 시뮬레이션 시작값(sim_init)이 정상 녹화와 이어지는가 ----
const simInit = await json(path.join(DATA, 'sim_init.json'));
ok('시작값: 랙 60기 모두 기준 전력과 위상이 있음', racks.every((n) => Number.isFinite(simInit.basePower[n.toLowerCase()]) && Number.isFinite(simInit.phase[n.toLowerCase()])), '');
{
  const { SimEngine, layoutFrom } = await import(pathToFileURL(path.join(HERE, '../src/sim/engine.js')).href);
  const lay = layoutFrom(scene.racks, sensors);
  const eng = new SimEngine({ sensors, ...lay, seed: 7, basePower: simInit.basePower, phase: simInit.phase });
  eng.startScenario('normal');
  const rec = await json(path.join(DATA, 'rec', 'normal.json'));
  let worst = 0;
  for (let i = 0; i < rec.n; i++) {
    const it = eng.step().find((m) => m.kind === 'aggregate' && m.name === 'it_power').value;
    worst = Math.max(worst, Math.abs(it - rec.aggregates.it_power[i]) / rec.aggregates.it_power[i]);
  }
  ok(`시작값: 시뮬레이션 정상 상태의 IT 전력이 녹화와 300초 내내 1% 안에서 이어짐 (최대 ${(worst * 100).toFixed(2)}%)`, worst < 0.01, `${(worst * 100).toFixed(2)}%`);
}

// ---- 6. 원본에서 다시 만들면 같은가 ----
const src = [path.join(ROOT, 'experiments/openfoam_baseline/layout.json'), path.join(ROOT, 'sim/out/sensor_manifest.json')];
if (src.every(existsSync) && (await readdir(path.join(ROOT, 'sim/out/recordings'))).some((f) => f.endsWith('_l2.jsonl'))) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dct-data-'));
  try {
    execFileSync(process.execPath, [path.join(HERE, 'build_data.mjs'), '--out', tmp], { stdio: 'pipe' });
    for (const f of ['scene.json', 'sensors.json', 'index.json']) ok(`재생성: ${f}가 웹 자료와 같음`, (await readFile(path.join(tmp, f), 'utf8')) === (await readFile(path.join(DATA, f), 'utf8')), '');
    ok('재생성: sim_init.json이 웹 자료와 같음', (await readFile(path.join(tmp, 'sim_init.json'), 'utf8')) === (await readFile(path.join(DATA, 'sim_init.json'), 'utf8')), '');
    ok('재생성: library.json이 웹 자료와 같음', (await readFile(path.join(tmp, 'library.json'), 'utf8')) === (await readFile(path.join(DATA, 'library.json'), 'utf8')), '');
    for (const it of index.filter((x) => !x.file)) ok(`재생성: rec/${it.id}.json이 웹 자료와 같음`, (await readFile(path.join(tmp, 'rec', `${it.id}.json`), 'utf8')) === (await readFile(path.join(DATA, 'rec', `${it.id}.json`), 'utf8')), '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
} else console.log('건너뜀  재생성 비교: 원본(sim/out)이 이 컴퓨터에 없음');

console.log(bad ? `\n실패 ${bad}건` : '\n모두 통과');
process.exit(bad ? 1 : 0);
