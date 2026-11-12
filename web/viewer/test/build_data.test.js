import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildScene, buildSensors, buildSimInit, convertRecording, SCENARIOS } from '../tools/build_data.mjs';
import { parseRecording } from '../src/recording.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data');

async function jsonl(lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dct-web-'));
  const file = path.join(dir, 'x.jsonl');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
const ts = (s) => new Date(Date.UTC(2026, 9, 15, 9, 0, s)).toISOString();
const sample = (id, s, v, extra = {}) => ({ type: 'sample', sensorId: id, ts: ts(s), value: v, unit: 'degC', quality: 'good', ...extra });

describe('녹화 변환 (JSONL -> 센서별 배열)', () => {
  const ids = ['A', 'B'];
  const base = () => [
    { type: 'scenario', event: 'start', name: 'x', ts: ts(0) },
    sample('A', 0, 20.1234, { lower: 19, upper: 21, confidence: 'ok' }),
    sample('B', 0, 30),
    { type: 'aggregate', name: 'pue', value: 1.13, ts: ts(0) },
    sample('A', 1, 21, { lower: 19.5, upper: 22.5, confidence: 'low' }),
    sample('B', 1, 31),
    { type: 'alarm', sensorId: 'B', from: 'normal', to: 'warn', value: 31, ts: ts(1) },
    { type: 'scenario', event: 'event', name: 'x', kind: 'crac_fan', target: 'crac_01', value: 0.15, t: 1, ts: ts(1) },
  ];

  it('값, 구간, 등급 코드, 알람, 사건, 집계를 옮긴다', async () => {
    const rec = await convertRecording(await jsonl(base()), 'x', ids);
    expect(rec.n).toBe(2);
    expect(rec.values.A).toEqual([20.123, 21]);
    expect(rec.est.A).toEqual({ lower: [19, 19.5], upper: [21, 22.5], conf: [1, 3] });
    expect(rec.est.B).toBeUndefined();
    expect(rec.alarms).toEqual([{ t: 1, sensorId: 'B', from: 'normal', to: 'warn', value: 31 }]);
    expect(rec.events).toEqual([{ t: 1, kind: 'crac_fan', target: 'crac_01', value: 0.15 }]);
    expect(rec.aggregates.pue).toEqual([1.13, null]);
    expect(() => parseRecording({ ...rec, aggregates: { pue: [1.13, 1.13] } }, ids)).not.toThrow();
  });

  it('시작 메시지의 보정 모델 출처를 녹화의 meta로 옮긴다(없으면 meta 자체가 없다)', async () => {
    const model = { source: 'model.pkl', model_sha256: 'abc', samples_json_sha256: 'def', n_samples: 64, stale: false };
    const withModel = base();
    withModel[0] = { ...withModel[0], model };
    const rec = await convertRecording(await jsonl(withModel), 'x', ids);
    expect(rec.meta).toEqual({ solver: 'l2', model });
    expect((await convertRecording(await jsonl(base()), 'x', ids)).meta).toBeUndefined();
  });

  it('1초 간격이 아니면 실패', async () => {
    const lines = base();
    lines.push({ ...sample('A', 1, 22), ts: new Date(Date.parse(ts(1)) + 500).toISOString() });
    await expect(convertRecording(await jsonl(lines), 'x', ids)).rejects.toThrow(/1초 간격/);
  });

  it('센서 값이 비는 칸이 있으면 실패', async () => {
    const lines = base().filter((l) => !(l.sensorId === 'B' && l.ts === ts(1) && l.type === 'sample'));
    await expect(convertRecording(await jsonl(lines), 'x', ids)).rejects.toThrow(/B/);
  });

  it('모르는 센서는 무시', async () => {
    const lines = [...base(), sample('ZZZ', 0, 1)];
    const rec = await convertRecording(await jsonl(lines), 'x', ids);
    expect(rec.values.ZZZ).toBeUndefined();
  });

  it('비어 있으면 실패', async () => {
    await expect(convertRecording(await jsonl([]), 'x', ids)).rejects.toThrow(/비어/);
  });
});

describe('장면과 센서 변환', () => {
  it('장면: 랙 줄 번호와 앞면 방향을 유지한다', () => {
    const layout = {
      size_cm: [1, 2, 3],
      racks: [{ name: 'Rack_11', path: '/DC/Hall01/Row02/Rack_11', min: [0, 0, 0], max: [60, 100, 200], front: [1, 1] }],
      cracs: [{ name: 'CRAC_01', path: 'p', min: [0, 0, 0], max: [1, 1, 1], front: [0, 1] }],
      vents: [],
      panels: [],
    };
    const s = buildScene(layout);
    expect(s.racks[0]).toMatchObject({ name: 'Rack_11', row: 2, front: [1, 1] });
    expect(s.cracs[0].front).toEqual([0, 1]);
    expect(s.plenum).toBeUndefined(); // 이중 바닥이 없는 장면은 넣지 않는다
    const p = buildScene({ ...layout, plenum: { depth_cm: 60, floor_cm: 20 }, underfloor: [{ name: 'Pipe_01', kind: 'pipe', min: [0, 0, -80], max: [20, 100, -60] }] });
    expect(p.plenum.depth_cm).toBe(60);
    expect(p.underfloor[0]).toEqual({ name: 'Pipe_01', kind: 'pipe', min: [0, 0, -80], max: [20, 100, -60] });
  });
  it('센서: 장비 이름을 토픽에서 뽑는다', () => {
    const [s] = buildSensors({ sensors: [{ sensorId: 'X', topic: 'dct/v1/hall01/rack_01/temp_in', equipmentType: 'rack', metric: 'temp_in', unit: 'degC', range: [10, 45], warn: 27, critical: 32 }] });
    expect(s).toMatchObject({ equipment: 'rack_01', direction: 'high', warn: 27 });
  });
});

describe('저장소에 올라간 정적 자료(public/data)', () => {
  it('모든 시나리오 녹화가 형식 검사를 통과하고 용량 기준 이내다', async () => {
    const sensors = JSON.parse(await readFile(path.join(PUBLIC, 'sensors.json'), 'utf8'));
    const ids = sensors.map((s) => s.sensorId);
    expect(ids).toHaveLength(204);
    for (const sc of SCENARIOS) {
      const text = await readFile(path.join(PUBLIC, 'rec', `${sc.id}.json`), 'utf8');
      const rec = parseRecording(JSON.parse(text), ids);
      expect(rec.n).toBe(300);
      expect(gzipSync(text).length).toBeLessThan(1024 * 1024);
    }
  });
  it('장면: 랙 60기, CRAC 8기, 통풍구 30개', async () => {
    const scene = JSON.parse(await readFile(path.join(PUBLIC, 'scene.json'), 'utf8'));
    expect(scene.racks).toHaveLength(60);
    expect(scene.cracs).toHaveLength(8);
    expect(scene.vents).toHaveLength(30);
  });
  it('팬 이상 녹화의 마지막 시각 등급이 ok 48, caution 8, low 4다', async () => {
    // 2026-11-04 보정 모델을 낮은 부하 샘플 8개를 더해 다시 학습하면서 이전 값(ok 48, low 12)에서 바뀌었다.
    // Unreal 실제 연결 확인(이전 값)은 이전 모델 기준이라 다시 확인해야 한다(docs/27 16.10).
    const rec = JSON.parse(await readFile(path.join(PUBLIC, 'rec', 'fan_fault.json'), 'utf8'));
    const codes = Object.values(rec.est).map((e) => e.conf.at(-1));
    expect(codes.filter((c) => c === 1)).toHaveLength(48);
    expect(codes.filter((c) => c === 2)).toHaveLength(8);
    expect(codes.filter((c) => c === 3)).toHaveLength(4);
  });
  it('모든 녹화가 같은 보정 모델(출처 기록)로 만들어졌다', async () => {
    const shas = new Set();
    for (const sc of SCENARIOS) {
      const rec = JSON.parse(await readFile(path.join(PUBLIC, 'rec', `${sc.id}.json`), 'utf8'));
      expect(rec.meta?.model?.stale, sc.id).toBe(false);
      shas.add(rec.meta.model.model_sha256);
    }
    expect(shas.size).toBe(1);
  });
});

describe('시뮬레이션 시작값 추정', () => {
  it('기준 전력과 위상을 되찾는다(주기의 정수 배 길이, 잡음 없음)', () => {
    const amp = 0.6;
    const period = 150;
    const base = 7.25;
    const phase = 1.2;
    const arr = Array.from({ length: 300 }, (_, t) => base + amp * Math.sin((2 * Math.PI * t) / period + phase));
    const r = buildSimInit({ n: 300, values: { 'H01-RK07-POWER': arr, 'H01-RK07-TEMP-IN': arr, 'H01-CR01-FAN-SPEED': arr } }, { amplitude: amp, periodS: period });
    expect(Object.keys(r.basePower)).toEqual(['rack_07']); // 랙 전력 센서만 쓴다
    expect(r.basePower.rack_07).toBeCloseTo(base, 2);
    expect(r.phase.rack_07).toBeCloseTo(phase, 2);
  });
});
