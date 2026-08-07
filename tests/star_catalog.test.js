import { describe, test, expect } from 'vitest';
import { StarCatalog } from '../star_catalog.js';

const FILE_A =
  'HD 1|*|010.0 +05.0|100.0|G2V|1 km\n' +
  'HD 2|*|020.0 -05.0|50.0|M5|2 km\n';
const FILE_B =
  'HD 3|*|030.0 +10.0|25.0|A5|3 km\n';

describe('StarCatalog.build', () => {
  test('indexes every record across multiple files', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    expect(cat.count).toBe(3);
  });

  test('positions are recoverable and match the source coordinates', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    const p0 = cat.getPosition(0);
    expect(p0.length()).toBeCloseTo(3261.56 / 100.0, 1);
  });

  test('raw lines are recovered exactly, without a trailing newline', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    expect(cat.getRawLine(0)).toBe('HD 1|*|010.0 +05.0|100.0|G2V|1 km');
    expect(cat.getRawLine(1)).toBe('HD 2|*|020.0 -05.0|50.0|M5|2 km');
    expect(cat.getRawLine(2)).toBe('HD 3|*|030.0 +10.0|25.0|A5|3 km');
  });

  test('names are recovered from the first pipe-separated field', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    expect(cat.getName(0)).toBe('HD 1');
    expect(cat.getName(2)).toBe('HD 3');
  });

  test('blank lines (e.g. a trailing newline) are skipped, not indexed', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A + '\n']);
    expect(cat.count).toBe(2);
  });

  test('malformed lines are skipped rather than throwing', () => {
    const cat = new StarCatalog();
    cat.build(['not enough fields\nHD 9|*|040.0 +00.0|10.0|K0|\n']);
    expect(cat.count).toBe(1);
    expect(cat.getName(0)).toBe('HD 9');
  });

  test('onCandidate fires once per parsed record with line and position', () => {
    const cat = new StarCatalog();
    const seen = [];
    cat.build([FILE_A, FILE_B], (line, position) => seen.push({ line, x: position.x }));
    expect(seen.length).toBe(3);
    expect(seen[0].line).toBe('HD 1|*|010.0 +05.0|100.0|G2V|1 km');
  });
});

describe('StarCatalog.find / filter', () => {
  test('find locates a record by name among the indexed catalog', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    const star = cat.find((s) => s.name === 'HD 2');
    expect(star).toBeDefined();
    expect(star.data).toBe('HD 2|*|020.0 -05.0|50.0|M5|2 km');
  });

  test('find returns undefined when nothing matches', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    expect(cat.find((s) => s.name === 'nope')).toBeUndefined();
  });

  test('filter returns a plain array supporting sort/slice/map', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A, FILE_B]);
    const results = cat
      .filter((s) => s.name.startsWith('HD'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => s.name);
    expect(results).toEqual(['HD 1', 'HD 2', 'HD 3']);
  });

  test('find/filter also see dynamic (mesh-backed) entries', () => {
    const cat = new StarCatalog();
    cat.build([FILE_A]);
    const fakeMesh = { position: { x: 1, y: 2, z: 3 } };
    cat.push({ name: 'S1', data: '', position: fakeMesh.position, mesh: fakeMesh });
    const found = cat.find((s) => s.name === 'S1');
    expect(found.mesh).toBe(fakeMesh);
  });
});
