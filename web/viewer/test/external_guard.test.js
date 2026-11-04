import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLibrary } from '../src/server_data.js';

// 외부 CFD 도구(상용 포함)의 결과는 저장소와 공개 사이트에 들어가면 안 된다(docs/04, CLAUDE.md). CI가 이 시험으로 막는다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = path.join(ROOT, 'web/viewer/public/data');

const tracked = () => {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch {
    return null; // git이 없거나 저장소가 아님
  }
};

describe('외부 솔버 결과 보호', () => {
  it('저장소에 외부 도구의 결과나 모델 파일(.vtk, .vtu, .vti, .room)과 변환 묶음이 추적되지 않는다', () => {
    const files = tracked();
    if (!files) return;
    const bad = files.filter((f) => /\.(vtk|vtu|vti|room)$/i.test(f) || f.includes('external_pack') || f.includes('external_demo'));
    expect(bad).toEqual([]);
  });

  it('공개 사이트의 목록에는 외부 솔버 결과가 없다(서버가 줄 때만 보인다)', () => {
    const index = JSON.parse(readFileSync(path.join(PUBLIC, 'index.json'), 'utf8'));
    const groups = JSON.parse(readFileSync(path.join(PUBLIC, 'library.json'), 'utf8')).groups;
    expect(index.filter((i) => i.source === 'external' || i.group === 'external' || /^ext_/.test(i.id))).toEqual([]);
    expect(groups.map((g) => g.id)).not.toContain('external');
    for (const i of index) expect(JSON.stringify(i)).not.toMatch(/external/i);
  });

  it('녹화 파일의 meta에도 외부 결과 표시가 없다', () => {
    for (const f of ['normal', 'supply_24', 'load_130', 'fan_fault']) {
      const rec = JSON.parse(readFileSync(path.join(PUBLIC, 'rec', `${f}.json`), 'utf8'));
      expect(rec.meta?.source).not.toBe('external');
    }
  });

  it('서버가 외부 결과 항목(source, tool, group=external)을 줘도 목록 검사를 통과한다', () => {
    const lib = parseLibrary({ index: [{ id: 'normal', title: 'N', n: 300 }, { id: 'ext_case1', title: '외부', group: 'external', source: 'external', tool: '도구', n: 300 }], groups: [{ id: 'external', title: '외부 솔버 결과 (로컬 전용)' }] });
    expect(lib.index.map((i) => i.id)).toEqual(['normal', 'ext_case1']);
    expect(lib.groups[0].id).toBe('external');
  });
});
