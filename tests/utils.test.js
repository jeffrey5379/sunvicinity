import { describe, test, expect } from 'vitest';
import {
  plxToLy,
  pcToLy,
  bayesianDistancePc,
  degreesToRad,
  raDecDistanceToXyz,
  xyzToRaDec,
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

// ── pcToLy ────────────────────────────────────────────────────────────────────
describe('pcToLy', () => {
  test('1 pc = 3.26156 ly', () => {
    expect(pcToLy(1)).toBeCloseTo(3.26156);
  });

  test('1000 pc matches plxToLy(1) (both are 1000 pc / 1 mas parallax)', () => {
    expect(pcToLy(1000)).toBeCloseTo(plxToLy(1));
  });

  test('scales linearly', () => {
    expect(pcToLy(20)).toBeCloseTo(pcToLy(10) * 2);
  });
});

// ── bayesianDistancePc ──────────────────────────────────────────────────────────
describe('bayesianDistancePc', () => {
  test('a confident, well-measured parallax matches naive 1/parallax (prior barely matters)', () => {
    // POE ~1000 (0.1% relative error) at 100 pc — the prior's pull is negligible.
    const naive = 1000 / 10; // 10 mas → 100 pc
    expect(bayesianDistancePc(10, 0.01, 1350)).toBeCloseTo(naive, 0);
  });

  test('a non-positive parallax still returns a finite, positive distance', () => {
    expect(bayesianDistancePc(-0.05, 0.5, 1350)).toBeGreaterThan(0);
    expect(bayesianDistancePc(0, 0.5, 1350)).toBeGreaterThan(0);
  });

  test('a noisy parallax is pulled toward the prior scale L, not the naive (unstable) inversion', () => {
    // parallax_over_error ~1: naive 1/plx is wildly unreliable here.
    const noisy = bayesianDistancePc(0.2, 0.2, 1350);
    const naive = 1000 / 0.2; // 5000 pc — the naive estimate this is meant to replace
    expect(noisy).toBeLessThan(naive);
    expect(noisy).toBeGreaterThan(0);
  });

  test('larger length scale pulls the (poorly measured) estimate further out', () => {
    const shortL = bayesianDistancePc(0.2, 0.2, 500);
    const longL = bayesianDistancePc(0.2, 0.2, 5000);
    expect(longL).toBeGreaterThan(shortL);
  });

  test('invalid inputs (non-positive error or length scale) return null', () => {
    expect(bayesianDistancePc(1, 0, 1350)).toBeNull();
    expect(bayesianDistancePc(1, -1, 1350)).toBeNull();
    expect(bayesianDistancePc(1, 0.1, 0)).toBeNull();
    expect(bayesianDistancePc(1, 0.1, -100)).toBeNull();
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

// ── raDecDistanceToXyz ──────────────────────────────────────────────────────────
describe('raDecDistanceToXyz', () => {
  test('ra=0, dec=0 points straight down +z', () => {
    expect(raDecDistanceToXyz(0, 0, 5)).toEqual({ x: expect.closeTo(0), y: expect.closeTo(0), z: expect.closeTo(5) });
  });

  test('ra=90, dec=0 points along +x', () => {
    const { x, y, z } = raDecDistanceToXyz(90, 0, 5);
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  test('dec=90 (north pole) points along +y regardless of ra', () => {
    for (const ra of [0, 45, 123, 300]) {
      const { x, y, z } = raDecDistanceToXyz(ra, 90, 5);
      expect(x).toBeCloseTo(0);
      expect(y).toBeCloseTo(5);
      expect(z).toBeCloseTo(0);
    }
  });

  test('dec=-90 (south pole) points along -y', () => {
    const { x, y, z } = raDecDistanceToXyz(200, -90, 5);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-5);
    expect(z).toBeCloseTo(0);
  });

  test('distance=0 collapses to the origin regardless of ra/dec', () => {
    const { x, y, z } = raDecDistanceToXyz(37, -22, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  test('magnitude of the result always equals the input distance', () => {
    for (const [ra, dec, d] of [[37, 22, 10], [200, -45, 3.5], [359, 89, 1000]]) {
      const { x, y, z } = raDecDistanceToXyz(ra, dec, d);
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(d);
    }
  });

  test('ra wraps the same as ra+360 (sin/cos are periodic)', () => {
    const a = raDecDistanceToXyz(-30, 15, 7);
    const b = raDecDistanceToXyz(330, 15, 7);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
    expect(a.z).toBeCloseTo(b.z);
  });

  test('round-trips through xyzToRaDec (documented inverse)', () => {
    for (const [ra, dec, d] of [[123.4, -45.6, 7.8], [0.1, 0, 50], [271, 60, 200]]) {
      const { x, y, z } = raDecDistanceToXyz(ra, dec, d);
      const back = xyzToRaDec(x, y, z);
      expect(back.raDegrees).toBeCloseTo(ra, 5);
      expect(back.decDegrees).toBeCloseTo(dec, 5);
    }
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
