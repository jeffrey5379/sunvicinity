import { describe, test, expect } from 'vitest';
import {
  plxToLy,
  degreesToRad,
  getSpectralClass,
  lumClassMult,
  giantBrightnessMult,
  angularDiameterToKm,
  teffToSpectralClass,
  bpRpToTeff,
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

// ── angularDiameterToKm ─────────────────────────────────────────────────────────
describe('angularDiameterToKm', () => {
  test('scales linearly with angular diameter', () => {
    const a = angularDiameterToKm(10, 100);
    const b = angularDiameterToKm(20, 100);
    expect(b).toBeCloseTo(a * 2);
  });

  test('scales linearly with distance', () => {
    const a = angularDiameterToKm(10, 100);
    const b = angularDiameterToKm(10, 200);
    expect(b).toBeCloseTo(a * 2);
  });

  test('roughly matches Betelgeuse\'s known scale (~50 mas at ~550 ly, a few AU across)', () => {
    const km = angularDiameterToKm(50, 550);
    expect(km).toBeGreaterThan(5e8);
    expect(km).toBeLessThan(3e9);
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

  test('maps LBV (Luminous Blue Variable) to B, not the brown-dwarf L', () => {
    expect(getSpectralClass('LBV')).toBe('B');
    expect(getSpectralClass('LBVe')).toBe('B');
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

// ── giantBrightnessMult ───────────────────────────────────────────────────────
describe('giantBrightnessMult', () => {
  test('Ia supergiants → 2.0', () => {
    expect(giantBrightnessMult('M1-M2Ia-Iab')).toBe(2.0);
    expect(giantBrightnessMult('K5Ia')).toBe(2.0);
  });

  test('Ib bright supergiants → 1.8', () => {
    expect(giantBrightnessMult('K5Ib')).toBe(1.8);
  });

  test('II bright giants → 1.6', () => {
    expect(giantBrightnessMult('G8II')).toBe(1.6);
  });

  test('III giants → 1.4', () => {
    expect(giantBrightnessMult('K5III')).toBe(1.4);
    expect(giantBrightnessMult('G8III')).toBe(1.4);
  });

  test('IV subgiants → 1.2', () => {
    expect(giantBrightnessMult('A1IV')).toBe(1.2);
  });

  test('V main sequence → 1.0', () => {
    expect(giantBrightnessMult('G2V')).toBe(1.0);
    expect(giantBrightnessMult('A5')).toBe(1.0);
  });

  test('empty string → 1.0', () => {
    expect(giantBrightnessMult('')).toBe(1.0);
  });

  test('null → 1.0', () => {
    expect(giantBrightnessMult(null)).toBe(1.0);
  });
});

// ── teffToSpectralClass ──────────────────────────────────────────────────────
describe('teffToSpectralClass', () => {
  test('Sun-like Teff (5778K) → G2', () => {
    expect(teffToSpectralClass(5778)).toBe('G2');
  });

  test('boundary values fall in the expected class', () => {
    expect(teffToSpectralClass(9000)).toMatch(/^A/);
    expect(teffToSpectralClass(6500)).toMatch(/^F/);
    expect(teffToSpectralClass(4500)).toMatch(/^K/);
    expect(teffToSpectralClass(3200)).toMatch(/^M/);
  });

  test('very hot clamps to O0, very cool clamps to M9', () => {
    expect(teffToSpectralClass(100000)).toBe('O0');
    expect(teffToSpectralClass(1000)).toBe('M9');
  });

  test('non-positive or missing Teff → null', () => {
    expect(teffToSpectralClass(0)).toBeNull();
    expect(teffToSpectralClass(-500)).toBeNull();
    expect(teffToSpectralClass(NaN)).toBeNull();
  });
});

// ── bpRpToTeff ────────────────────────────────────────────────────────────────
describe('bpRpToTeff', () => {
  test("Sun's B-V (0.65) reproduces the Sun's Teff (calibration point)", () => {
    expect(bpRpToTeff(0.65)).toBeCloseTo(5778, 0);
  });

  test('redder (larger) color → cooler Teff', () => {
    expect(bpRpToTeff(2.0)).toBeLessThan(bpRpToTeff(0.5));
  });

  test('non-finite input → null', () => {
    expect(bpRpToTeff(NaN)).toBeNull();
    expect(bpRpToTeff(undefined)).toBeNull();
  });
});
