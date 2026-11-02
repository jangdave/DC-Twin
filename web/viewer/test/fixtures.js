// 시험용 작은 자료: 센서 3개(랙 2기의 입구 온도, CRAC 팬), 녹화 10초
export const sensors = [
  { sensorId: 'R1-T', equipment: 'rack_01', equipmentType: 'rack', metric: 'temp_in', unit: 'degC', range: [10, 45], warn: 27, critical: 32, direction: 'high' },
  { sensorId: 'R2-T', equipment: 'rack_02', equipmentType: 'rack', metric: 'temp_in', unit: 'degC', range: [10, 45], warn: 27, critical: 32, direction: 'high' },
  { sensorId: 'C1-F', equipment: 'crac_01', equipmentType: 'crac', metric: 'fan_speed', unit: 'percent', range: [0, 100], warn: 20, critical: 5, direction: 'low' },
];

export function makeRec() {
  const n = 10;
  const ramp = (a, b) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  return {
    version: 1,
    scenario: 'test',
    startTs: '2026-10-15T09:00:00.000Z',
    dt: 1,
    n,
    values: { 'R1-T': ramp(20, 29), 'R2-T': ramp(21, 21), 'C1-F': Array(n).fill(100) },
    est: { 'R1-T': { lower: ramp(19, 27), upper: ramp(21, 33), conf: [1, 1, 1, 2, 2, 2, 3, 3, 3, 3] } },
    aggregates: { it_power: ramp(400, 410), pue: Array(n).fill(1.13) },
    alarms: [
      { t: 4, sensorId: 'R1-T', from: 'normal', to: 'warn', value: 24.9 },
      { t: 8, sensorId: 'R1-T', from: 'warn', to: 'critical', value: 28.1 },
    ],
    events: [{ t: 3, kind: 'crac_fan', target: 'crac_01', value: 0.15 }],
  };
}
