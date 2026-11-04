import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { alarmSets, buildCameras, orderCameras, pageOf, zoneAlarmed } from '../src/cctv.js';

const data = JSON.parse(readFileSync(new URL('../public/data/scene.json', import.meta.url)));
const cams = buildCameras(data);
const inside = (p) => p[0] >= 0 && p[0] <= data.size[0] && p[1] >= 0 && p[1] <= data.size[1];

describe('buildCameras', () => {
  it('출입구, 통로 3곳, 냉각 2곳, 천장 = 7대', () => {
    expect(cams.map((c) => c.id)).toEqual(['entrance', 'aisle_1_2', 'aisle_3_4', 'aisle_5_6', 'crac_west', 'crac_east', 'ceiling']);
  });
  it('번호와 이름이 겹치지 않는다', () => {
    expect(new Set(cams.map((c) => c.id)).size).toBe(cams.length);
    expect(new Set(cams.map((c) => c.name)).size).toBe(cams.length);
  });
  it('천장 카메라를 뺀 모든 카메라는 홀 안에 있고 높이가 천장 아래다', () => {
    for (const c of cams.filter((c) => c.id !== 'ceiling')) {
      expect(inside(c.pos)).toBe(true);
      expect(c.pos[2]).toBeLessThan(data.size[2]);
    }
    expect(cams.find((c) => c.id === 'ceiling').pos[2]).toBeGreaterThan(data.size[2]);
  });
  it('통로 카메라는 두 줄 사이 가운데에 있다', () => {
    const a = cams.find((c) => c.id === 'aisle_1_2');
    const r1 = data.racks.filter((r) => r.row === 1);
    const r2 = data.racks.filter((r) => r.row === 2);
    expect(a.pos[1]).toBeGreaterThan(Math.max(...r1.map((r) => r.max[1])));
    expect(a.pos[1]).toBeLessThan(Math.min(...r2.map((r) => r.min[1])));
  });
  it('랙 배치가 바뀌면 카메라도 바뀐다(좌표를 박아 두지 않음)', () => {
    const moved = { ...data, racks: data.racks.map((r) => (r.row === 1 ? { ...r, min: [r.min[0], r.min[1] - 40, r.min[2]], max: [r.max[0], r.max[1] - 40, r.max[2]] } : r)) };
    const before = cams.find((c) => c.id === 'aisle_1_2').pos[1];
    const after = buildCameras(moved).find((c) => c.id === 'aisle_1_2').pos[1];
    expect(after).not.toBe(before);
  });
});

describe('알람 구역', () => {
  const worst = (hot) => (k) => (hot.includes(k) ? 'warn' : 'normal');
  it('알람이 없으면 어느 카메라도 표시하지 않는다', () => {
    const s = alarmSets(data, worst([]));
    expect(cams.some((c) => zoneAlarmed(c, s))).toBe(false);
  });
  it('3번 줄 랙 알람은 통로 3·4와 출입구, 천장에만 표시한다', () => {
    const r3 = data.racks.find((r) => r.row === 3).name.toLowerCase();
    const s = alarmSets(data, worst([r3]));
    expect(cams.filter((c) => zoneAlarmed(c, s)).map((c) => c.id).sort()).toEqual(['aisle_3_4', 'ceiling', 'entrance']);
  });
  it('CRAC_02 알람은 서쪽 냉각 카메라에만 표시한다(전체 카메라 제외)', () => {
    const s = alarmSets(data, worst(['crac_02']));
    expect(cams.filter((c) => zoneAlarmed(c, s) && !c.zone.all).map((c) => c.id)).toEqual(['crac_west']);
  });
  it('알람 구역이 앞으로 온다', () => {
    const s = alarmSets(data, worst(['crac_06']));
    expect(orderCameras(cams, s)[0].id).toBe('crac_east');
  });
});

describe('pageOf', () => {
  it('칸 수만큼 자르고 끝을 넘으면 처음으로 돌아간다', () => {
    expect(pageOf(cams, 4, 0).length).toBe(4);
    expect(pageOf(cams, 4, 1).length).toBe(3);
    expect(pageOf(cams, 4, 2).map((c) => c.id)).toEqual(pageOf(cams, 4, 0).map((c) => c.id));
    expect(pageOf(cams, 2, -1).length).toBe(1);
  });
});
