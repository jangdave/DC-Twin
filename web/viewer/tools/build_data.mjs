// 웹 보기 화면용 정적 자료를 만든다 (docs/18 4.2~4.3장).
//   node tools/build_data.mjs [--out public/data]
// 원본: experiments/openfoam_baseline/layout.json(장면 USD에서 뽑은 상자 좌표), sim/out/sensor_manifest.json, sim/out/recordings/*_l2.jsonl
// 결과: scene.json, sensors.json, index.json, rec/<시나리오>.json (센서별 배열로 줄인 녹화)
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

export const SCENARIOS = [
  { id: 'normal', file: 'normal_l2.jsonl', title: '정상 가동', note: '랙 온도가 완만하게 움직인다.' },
  { id: 'cooling_failure', file: 'cooling_failure_l2.jsonl', title: 'CRAC 고장', note: '냉각 장치 한 대가 멈추면 가까운 랙부터 오른다.' },
  { id: 'fan_fault', file: 'fan_fault_l2.jsonl', title: '팬 이상', note: '냉각 장치 팬이 15%로 떨어진다. 보정 모델이 낮은 신뢰 등급을 보이는 랙이 생긴다.' },
  { id: 'power_spike', file: 'power_spike_l2.jsonl', title: '전력 급증', note: '일부 랙의 전력이 갑자기 올라간다.' },
];
const CONF_CODE = { ok: 1, caution: 2, low: 3, fallback: 4 };
const AGGREGATES = ['it_power', 'cooling_power', 'facility_power', 'pue', 'energy_kwh'];
const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

// ---- 장면 ----
export function buildScene(layout) {
  const box = (o) => ({ name: o.name, min: o.min.map(round3), max: o.max.map(round3) });
  return {
    version: 1,
    unit: 'cm',
    size: layout.size_cm,
    racks: layout.racks.map((r) => ({ ...box(r), row: Number(/\/Row(\d+)\//.exec(r.path)?.[1] ?? 0), front: r.front })),
    cracs: layout.cracs.map((c) => ({ ...box(c), front: c.front })),
    vents: layout.vents.map(box),
    panels: layout.panels.map(box),
  };
}

// ---- 시뮬레이션 시작값 ----
// 시뮬레이션 메뉴가 녹화(모니터링)와 같은 상태에서 시작하도록, 정상 녹화에서 랙별 기준 전력과 출렁임 위상을 추정한다.
// 전력 = 기준 + 진폭 x sin(2 pi t / 주기 + 위상) + 잡음. 녹화 길이가 주기의 정수 배일 때 최소제곱 풀이가 직교해 평균과 두 성분으로 갈린다.
export function buildSimInit(rec, { amplitude, periodS }) {
  const basePower = {};
  const phase = {};
  const w = (2 * Math.PI) / periodS;
  for (const [id, arr] of Object.entries(rec.values)) {
    const m = /^H\d+-RK(\d+)-POWER$/.exec(id);
    if (!m) continue;
    const name = `rack_${m[1]}`;
    const n = arr.length;
    const mean = arr.reduce((p, q) => p + q, 0) / n;
    let s = 0;
    let c = 0;
    for (let t = 0; t < n; t++) {
      s += (arr[t] - mean) * Math.sin(w * t);
      c += (arr[t] - mean) * Math.cos(w * t);
    }
    // arr - mean ~ amplitude * (cos(phase) * sin + sin(phase) * cos)
    basePower[name] = round3(mean);
    phase[name] = round3(Math.atan2(c, s));
  }
  return { version: 1, note: '정상 녹화에서 추정한 랙별 기준 전력(kW)과 출렁임 위상(rad). 시뮬레이션 시작값으로 쓴다.', amplitude, periodS, recSeconds: rec.n, basePower, phase };
}

// ---- 센서 ----
export function buildSensors(manifest) {
  return manifest.sensors.map((s) => ({
    sensorId: s.sensorId,
    equipment: s.topic.split('/')[3], // 예: rack_01, crac_01
    equipmentType: s.equipmentType,
    metric: s.metric,
    unit: s.unit,
    range: s.range,
    warn: s.warn ?? null,
    critical: s.critical ?? null,
    direction: s.direction ?? 'high',
  }));
}

// ---- 녹화 ----
// 한 줄씩 읽어 시간 칸(초)에 센서별 값을 채운다. 간격이 일정하지 않거나 센서 칸이 비면 실패시킨다.
export async function convertRecording(jsonlPath, scenarioId, sensorIds) {
  const known = new Set(sensorIds);
  let startMs = null;
  const rows = []; // [ {sensorId:..., ...} ]
  const events = [];
  const alarmsRaw = [];
  const aggRaw = [];
  const rl = readline.createInterface({ input: createReadStream(jsonlPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const ms = Date.parse(r.ts);
    if (startMs === null || ms < startMs) startMs = ms;
    if (r.type === 'sample') rows.push(r);
    else if (r.type === 'aggregate') aggRaw.push(r);
    else if (r.type === 'alarm') alarmsRaw.push(r);
    else if (r.type === 'scenario' && r.event === 'event') events.push(r);
  }
  if (startMs === null) throw new Error(`${jsonlPath}: 비어 있다`);
  const sec = (ts) => {
    const d = (Date.parse(ts) - startMs) / 1000;
    if (!Number.isInteger(d)) throw new Error(`${jsonlPath}: 시각이 1초 간격이 아니다 (${ts})`);
    return d;
  };
  let n = 0;
  for (const r of rows) n = Math.max(n, sec(r.ts) + 1);
  const values = {};
  const est = {};
  for (const id of sensorIds) values[id] = new Array(n).fill(null);
  for (const r of rows) {
    if (!known.has(r.sensorId)) continue;
    const t = sec(r.ts);
    values[r.sensorId][t] = r.quality === 'good' || r.quality === undefined ? round3(r.value) : null;
    if (r.confidence !== undefined || r.lower !== undefined) {
      const e = (est[r.sensorId] ??= { lower: new Array(n).fill(null), upper: new Array(n).fill(null), conf: new Array(n).fill(0) });
      e.lower[t] = round3(r.lower);
      e.upper[t] = round3(r.upper);
      e.conf[t] = CONF_CODE[r.confidence] ?? 0;
    }
  }
  // 모든 센서가 모든 시간 칸에 값이 있어야 한다(없으면 원본이나 변환이 틀린 것)
  for (const id of sensorIds) {
    const missing = values[id].filter((v) => v === null).length;
    if (missing) throw new Error(`${jsonlPath}: ${id}에 값이 없는 칸 ${missing}개`);
  }
  const aggregates = {};
  for (const name of AGGREGATES) aggregates[name] = new Array(n).fill(null);
  for (const a of aggRaw) if (a.name in aggregates) aggregates[a.name][sec(a.ts)] = round3(a.value);
  return {
    version: 1,
    scenario: scenarioId,
    startTs: new Date(startMs).toISOString(),
    dt: 1,
    n,
    values,
    est,
    aggregates,
    alarms: alarmsRaw.map((a) => ({ t: sec(a.ts), sensorId: a.sensorId, from: a.from, to: a.to, value: round3(a.value) })).sort((x, y) => x.t - y.t),
    events: events.map((e) => ({ t: e.t ?? sec(e.ts), kind: e.kind, target: e.target, value: e.value })),
  };
}

async function main() {
  const out = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(HERE, '../public/data'));
  await mkdir(path.join(out, 'rec'), { recursive: true });
  const layout = JSON.parse(await readFile(path.join(ROOT, 'experiments/openfoam_baseline/layout.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'sim/out/sensor_manifest.json'), 'utf8'));
  const sensors = buildSensors(manifest);
  const ids = sensors.map((s) => s.sensorId);
  await writeFile(path.join(out, 'scene.json'), JSON.stringify(buildScene(layout)));
  await writeFile(path.join(out, 'sensors.json'), JSON.stringify(sensors));
  const index = [];
  for (const sc of SCENARIOS) {
    const rec = await convertRecording(path.join(ROOT, 'sim/out/recordings', sc.file), sc.id, ids);
    const text = JSON.stringify(rec);
    await writeFile(path.join(out, 'rec', `${sc.id}.json`), text);
    index.push({ id: sc.id, title: sc.title, note: sc.note, n: rec.n, bytes: Buffer.byteLength(text) });
    console.log(`${sc.id}: ${rec.n}초, 센서 ${ids.length}개, ${(Buffer.byteLength(text) / 1e6).toFixed(2)} MB, 알람 ${rec.alarms.length}건`);
  }
  await writeFile(path.join(out, 'index.json'), JSON.stringify(index));
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(HERE, '../src/sim/core.js')).href);
  const normal = JSON.parse(await readFile(path.join(out, 'rec', 'normal.json'), 'utf8'));
  await writeFile(path.join(out, 'sim_init.json'), JSON.stringify(buildSimInit(normal, { amplitude: DEFAULT_CONFIG.power_wobble, periodS: DEFAULT_CONFIG.power_period_s })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
