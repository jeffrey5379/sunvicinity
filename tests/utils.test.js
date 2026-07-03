import { describe, test, expect } from 'vitest';
import {
  plxToLy,
  degreesToRad,
  parseStarFields,
  getSpectralClass,
  lumClassMult,
} from '../utils.js';

// ── plxToLy ───────────────────────────────────────────────────────────────────
describe('plxToLy', () => {
  test('1 mas parallax = 3261.56 ly (1 parsec)', () => {
    expect(plxToLy(1)).toBeCloseTo(3261.56);
  });

  test('Proxima Centauri ~768.5 mas → ~4.24 ly', () => {
    expect(plxToLy(768.5)).toBeCloseTo(4.24, 1);
  });

  test('Sirius ~379.2 mas → ~8.6 ly', () => {
    expect(plxToLy(379.2)).toBeCloseTo(8.6, 1);
  });

  test('larger parallax = closer star (inverse relationship)', () => {
    expect(plxToLy(100)).toBeLessThan(plxToLy(10));
  });
});

// ── degreesToRad ──────────────────────────────────────────────────────────────
describe('degreesToRad', () => {
  test('0° = 0 rad', () => {
    expect(degreesToRad(0)).toBe(0);
  });

  test('180° = π rad', () => {
    expect(degreesToRad(180)).toBeCloseTo(Math.PI);
  });

  test('90° = π/2 rad', () => {
    expect(degreesToRad(90)).toBeCloseTo(Math.PI / 2);
  });

  test('360° = 2π rad', () => {
    expect(degreesToRad(360)).toBeCloseTo(2 * Math.PI);
  });

  test('negative degrees work correctly', () => {
    expect(degreesToRad(-90)).toBeCloseTo(-Math.PI / 2);
  });
});

// ── parseStarFields ───────────────────────────────────────────────────────────
describe('parseStarFields', () => {
  test('parses all fields from a standard data line', () => {
    const line = 'HD 235588|*|325.1826637300200 +52.0960041963100|4.1069|A5|';
    const r = parseStarFields(line);
    expect(r.name).toBe('HD 235588');
    expect(r.type).toBe('*');
    expect(r.coords).toBe('325.1826637300200 +52.0960041963100');
    expect(r.plx).toBeCloseTo(4.1069);
    expect(r.spectralType).toBe('A5');
  });

  test('parses a binary star entry', () => {
    const line = 'HD 235593|**|325.5258729 +53.3593775|3.66|F2|';
    const r = parseStarFields(line);
    expect(r.type).toBe('**');
    expect(r.plx).toBeCloseTo(3.66);
    expect(r.spectralType).toBe('F2');
  });

  test('handles missing size field gracefully', () => {
    const line = 'TestStar|*|10.0 +20.0|5.0|G2V|';
    const r = parseStarFields(line);
    expect(r.size).toBe('');
  });

  test('name is first pipe-separated field', () => {
    const line = 'Sun|*|000.0 +00.0|0|G2V|1 km';
    expect(parseStarFields(line).name).toBe('Sun');
  });
});

// ── getSpectralClass ──────────────────────────────────────────────────────────
describe('getSpectralClass', () => {
  test('extracts G from G2V', () => {
    expect(getSpectralClass('G2V')).toBe('G');
  });

  test('extracts M from M1-M2Ia-Iab', () => {
    expect(getSpectralClass('M1-M2Ia-Iab')).toBe('M');
  });

  test('extracts A from A5', () => {
    expect(getSpectralClass('A5')).toBe('A');
  });

  test('extracts K from K5III', () => {
    expect(getSpectralClass('K5III')).toBe('K');
  });

  test('returns empty string for null', () => {
    expect(getSpectralClass(null)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(getSpectralClass('')).toBe('');
  });
});

// ── lumClassMult ──────────────────────────────────────────────────────────────
describe('lumClassMult', () => {
  test('Ia supergiants → 2.0', () => {
    expect(lumClassMult('M1-M2Ia-Iab')).toBe(2.0);
    expect(lumClassMult('K5Ia')).toBe(2.0);
  });

  test('Ib bright supergiants → 1.8', () => {
    expect(lumClassMult('K5Ib')).toBe(1.8);
  });

  test('II bright giants → 1.6', () => {
    expect(lumClassMult('G8II')).toBe(1.6);
  });

  test('III giants → 1.4', () => {
    expect(lumClassMult('K5III')).toBe(1.4);
    expect(lumClassMult('G8III')).toBe(1.4);
  });

  test('IV subgiants → 1.2', () => {
    expect(lumClassMult('A1IV')).toBe(1.2);
  });

  test('V main sequence → 1.0', () => {
    expect(lumClassMult('G2V')).toBe(1.0);
    expect(lumClassMult('A5')).toBe(1.0);
  });

  test('empty string → 1.0', () => {
    expect(lumClassMult('')).toBe(1.0);
  });

  test('null → 1.0', () => {
    expect(lumClassMult(null)).toBe(1.0);
  });

  test('III is not matched as II (no false positive)', () => {
    // K5III must give 1.4 (III), not 1.6 (II)
    expect(lumClassMult('K5III')).toBe(1.4);
  });
});
