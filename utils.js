// Pure utility functions — no Three.js or DOM dependencies.
// Imported by visuals.js and index.html; tested by tests/utils.test.js.

export function plxToLy(plx) {
  return 3261.56 / plx;
}

export function degreesToRad(degrees) {
  return (degrees * Math.PI) / 180.0;
}

export function raDecDistanceToXyz(raDegrees, decDegrees, distance) {
  const ra = degreesToRad(raDegrees);
  const dec = degreesToRad(decDegrees);
  const cosDec = Math.cos(dec);
  return {
    x: distance * cosDec * Math.sin(ra),
    y: distance * Math.sin(dec),
    z: distance * cosDec * Math.cos(ra),
  };
}

const KM_PER_LY = 9.4607e12;
const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

export const SUN_DIAMETER_KM = 1391400;

export function angularDiameterToKm(diameterMas, distanceLy) {
  return diameterMas * MAS_TO_RAD * distanceLy * KM_PER_LY;
}

// Extracts the primary spectral class letter (O B A F G K M L T Y W D C X).
export function getSpectralClass(spectralType) {
  if (!spectralType) return '';
  if (/LBV/i.test(spectralType)) return 'B';
  const match = spectralType.match(/[OBAFGKMLTYXWDC]/);
  return match ? match[0] : '';
}

// Returns a brightness multiplier based on the luminosity class encoded in
// a full spectral type string (e.g. "M1-M2Ia-Iab", "K5III", "A1V").
export function lumClassMult(spectralType) {
  if (!spectralType) return 1.0;
  if (/Ia/.test(spectralType)) return 2.0;   // supergiants (Ia, Iab)
  if (/Ib/.test(spectralType)) return 1.8;   // bright supergiants
  if (/III/.test(spectralType)) return 1.4;  // giants — must come before II check
  if (/II[^I]|II$/.test(spectralType)) return 1.6; // bright giants (II not III)
  if (/IV/.test(spectralType)) return 1.2;   // subgiants
  return 1.0;                                // V / VI / unknown
}

export function giantBrightnessMult(spectralType) {
  if (!spectralType) return 1.0;
  if (/Ia/.test(spectralType)) return 2.0;   // supergiants (Ia, Iab)
  if (/Ib/.test(spectralType)) return 1.8;   // bright supergiants
  if (/III/.test(spectralType)) return 1.4;  // giants — must come before II check
  if (/II[^I]|II$/.test(spectralType)) return 1.6; // bright giants (II not III)
  if (/IV/.test(spectralType)) return 1.2;   // subgiants
  return 1.0;                                // V / VI / unknown
}

export function maxVisibilityDistance(spectralType, config) {
  const spectralClass = getSpectralClass(spectralType);
  const lumMult = lumClassMult(spectralType);
  const isGiant = lumMult > 1.0;
  const entry = config[spectralClass];
  if (entry && entry.noGlow && !isGiant) return config.closeRangeLy;
  const base = entry && entry.glowMaxDist != null ? entry.glowMaxDist : config.defaultGlowMaxDist;
  return base * lumMult;
}

const TEFF_CLASS_RANGES = [
  { letter: "O", hi: 50000, lo: 30000 },
  { letter: "B", hi: 30000, lo: 10000 },
  { letter: "A", hi: 10000, lo: 7500 },
  { letter: "F", hi: 7500, lo: 6000 },
  { letter: "G", hi: 6000, lo: 5200 },
  { letter: "K", hi: 5200, lo: 3700 },
  { letter: "M", hi: 3700, lo: 2400 },
];

export function teffToSpectralClass(teff) {
  if (!(teff > 0)) return null;
  const range =
    TEFF_CLASS_RANGES.find((r) => teff >= r.lo && teff < r.hi) ||
    (teff >= TEFF_CLASS_RANGES[0].hi ? TEFF_CLASS_RANGES[0] : TEFF_CLASS_RANGES[TEFF_CLASS_RANGES.length - 1]);
  const clamped = Math.min(range.hi, Math.max(range.lo, teff));
  const frac = (range.hi - clamped) / (range.hi - range.lo); // 0 at the hot edge, 1 at the cool edge
  const subclass = Math.min(9, Math.max(0, Math.round(frac * 9)));
  return `${range.letter}${subclass}`;
}

export function bpRpToTeff(bpRp) {
  if (!Number.isFinite(bpRp)) return null;
  const x = 0.92 * bpRp;
  return 4600 * (1 / (x + 1.7) + 1 / (x + 0.62));
}
