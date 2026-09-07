import { describe, test, expect } from 'vitest';
import { StarCatalog } from '../star_catalog.js';

const HEADER_FIELDS = 9;
const HEADER_BYTES = HEADER_FIELDS * 4;

function buildBatchBuffer(stars, dictionaries) {
  const count = stars.length;
  const positions = new Float32Array(count * 3);
  const otypeCode = new Uint16Array(count);
  const spectralTypeIndex = new Uint16Array(count);
  const diameterSolar = new Float32Array(count);
  const nameOffsets = new Uint32Array(count + 1);
  const encoder = new TextEncoder();
  const nameChunks = [];
  let nameByteLength = 0;

  stars.forEach((star, i) => {
    positions[i * 3] = star.x;
    positions[i * 3 + 1] = star.y;
    positions[i * 3 + 2] = star.z;
    otypeCode[i] = dictionaries.otypes.indexOf(star.otype ?? '');
    spectralTypeIndex[i] = dictionaries.spectralTypes.indexOf(star.spectralType ?? '');
    diameterSolar[i] = star.diameterSolar ?? 0;
    const bytes = encoder.encode(star.name);
    nameOffsets[i] = nameByteLength;
    nameChunks.push(bytes);
    nameByteLength += bytes.length;
  });
  nameOffsets[count] = nameByteLength;

  const namesBlob = new Uint8Array(nameByteLength);
  let cursor = 0;
  for (const bytes of nameChunks) {
    namesBlob.set(bytes, cursor);
    cursor += bytes.length;
  }

  const sections = [
    new Uint8Array(positions.buffer),
    new Uint8Array(otypeCode.buffer),
    new Uint8Array(spectralTypeIndex.buffer),
    new Uint8Array(diameterSolar.buffer),
    new Uint8Array(nameOffsets.buffer),
    namesBlob,
  ];
  let offset = HEADER_BYTES;
  const offsets = [];
  for (const section of sections) {
    offset += (4 - (offset % 4)) % 4;
    offsets.push(offset);
    offset += section.length;
  }

  const buffer = new ArrayBuffer(offset);
  const out = new Uint8Array(buffer);
  sections.forEach((section, i) => out.set(section, offsets[i]));

  const header = new Uint32Array(buffer, 0, HEADER_FIELDS);
  header.set([
    count, 1, offsets[0], offsets[1], offsets[2], offsets[4], offsets[5], namesBlob.length, offsets[3],
  ]);

  return buffer;
}

const DICTIONARIES = { otypes: ['*', 'SB*'], spectralTypes: ['G2V', 'M5', 'A5'] };

const BATCH_A = [
  { x: 10, y: 0, z: 0, otype: '*', spectralType: 'G2V', name: 'HD 1' },
  { x: 0, y: 20, z: 0, otype: '*', spectralType: 'M5', name: 'HD 2', diameterSolar: 2.5 },
];
const BATCH_B = [{ x: 0, y: 0, z: 30, otype: 'SB*', spectralType: 'A5', name: 'HD 3' }];

describe('StarCatalog.build', () => {
  test('indexes every record across multiple batches', () => {
    const cat = new StarCatalog();
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
    );
    expect(cat.count).toBe(3);
  });

  test('positions are recovered exactly as given', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    const p0 = cat.getPosition(0);
    expect(p0.x).toBeCloseTo(10);
    expect(p0.y).toBeCloseTo(0);
    const p1 = cat.getPosition(1);
    expect(p1.y).toBeCloseTo(20);
  });

  test('names are recovered from the per-batch name blob', () => {
    const cat = new StarCatalog();
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
    );
    expect(cat.getName(0)).toBe('HD 1');
    expect(cat.getName(1)).toBe('HD 2');
    expect(cat.getName(2)).toBe('HD 3');
  });

  test('otype and spectral type are resolved through the shared dictionaries', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    expect(cat.getOtype(1)).toBe('*');
    expect(cat.getSpectralType(1)).toBe('M5');
  });

  test('diameterSolar is recovered when present, 0 when no measurement', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    expect(cat.getDiameterSolar(0)).toBe(0);
    expect(cat.getDiameterSolar(1)).toBeCloseTo(2.5);
  });

  test('onCandidate fires once per parsed record with position and index', () => {
    const cat = new StarCatalog();
    const seen = [];
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
      (position, index) => seen.push({ index, x: position.x }),
    );
    expect(seen.length).toBe(3);
    expect(seen[0]).toEqual({ index: 0, x: 10 });
    expect(seen[2]).toEqual({ index: 2, x: 0 });
  });

  test('accessor methods work when called from inside onCandidate, mid-build', () => {
    const cat = new StarCatalog();
    const seen = [];
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
      (position, index) => {
        seen.push({
          index,
          name: cat.getName(index),
          otype: cat.getOtype(index),
          spectralType: cat.getSpectralType(index),
          position: cat.getPosition(index),
        });
      },
    );
    expect(seen).toEqual([
      { index: 0, name: 'HD 1', otype: '*', spectralType: 'G2V', position: expect.objectContaining({ x: 10 }) },
      { index: 1, name: 'HD 2', otype: '*', spectralType: 'M5', position: expect.objectContaining({ y: 20 }) },
      { index: 2, name: 'HD 3', otype: 'SB*', spectralType: 'A5', position: expect.objectContaining({ z: 30 }) },
    ]);
  });
});

describe('StarCatalog.find / filter', () => {
  test('find locates a record by name among the indexed catalog', () => {
    const cat = new StarCatalog();
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
    );
    const star = cat.find((s) => s.name === 'HD 2');
    expect(star).toBeDefined();
    expect(star.spectralType).toBe('M5');
  });

  test('find returns undefined when nothing matches', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    expect(cat.find((s) => s.name === 'nope')).toBeUndefined();
  });

  test('filter returns a plain array supporting sort/slice/map', () => {
    const cat = new StarCatalog();
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
    );
    const results = cat
      .filter((s) => s.name.startsWith('HD'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => s.name);
    expect(results).toEqual(['HD 1', 'HD 2', 'HD 3']);
  });

  test('find/filter also see dynamic (mesh-backed) entries', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    const fakeMesh = { position: { x: 1, y: 2, z: 3 } };
    cat.push({ name: 'S1', position: fakeMesh.position, mesh: fakeMesh });
    const found = cat.find((s) => s.name === 'S1');
    expect(found.mesh).toBe(fakeMesh);
  });
});

describe('StarCatalog.findByName', () => {
  test('locates a record by exact name via the index', () => {
    const cat = new StarCatalog();
    cat.build(
      [buildBatchBuffer(BATCH_A, DICTIONARIES), buildBatchBuffer(BATCH_B, DICTIONARIES)],
      DICTIONARIES,
    );
    const star = cat.findByName('HD 2');
    expect(star).toBeDefined();
    expect(star.spectralType).toBe('M5');
  });

  test('is case- and whitespace-insensitive', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    expect(cat.findByName('hd 1')).toBeDefined();
    expect(cat.findByName('  HD 1  ')).toBeDefined();
  });

  test('returns undefined when nothing matches', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    expect(cat.findByName('nope')).toBeUndefined();
    expect(cat.findByName('')).toBeUndefined();
    expect(cat.findByName(null)).toBeUndefined();
  });

  test('also sees dynamic (mesh-backed) entries', () => {
    const cat = new StarCatalog();
    cat.build([buildBatchBuffer(BATCH_A, DICTIONARIES)], DICTIONARIES);
    const fakeMesh = { position: { x: 1, y: 2, z: 3 } };
    cat.push({ name: 'S1', position: fakeMesh.position, mesh: fakeMesh });
    expect(cat.findByName('s1').mesh).toBe(fakeMesh);
  });

  test('still finds a star with an unindexed "Gaia DR3 <id>" name via fallback', () => {
    const cat = new StarCatalog();
    const batch = [{ x: 5, y: 5, z: 5, otype: '*', spectralType: 'M5', name: 'Gaia DR3 123456789' }];
    cat.build([buildBatchBuffer(batch, DICTIONARIES)], DICTIONARIES);
    const star = cat.findByName('Gaia DR3 123456789');
    expect(star).toBeDefined();
    expect(star.spectralType).toBe('M5');
  });
});
