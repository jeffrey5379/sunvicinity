// Pure utility functions — no Three.js or DOM dependencies.
// Imported by star-visuals.js and index.html; tested by tests/star-utils.test.js.

export function plxToLy(plx) {
  return 3261.56 / plx;
}

export function degreesToRad(degrees) {
  return (degrees * Math.PI) / 180.0;
}

// Parses a pipe-separated star data line into named fields.
export function parseStarFields(line) {
  const parts = line.split('|');
  return {
    name: parts[0] || '',
    type: parts[1] || '',
    coords: parts[2] || '',
    plx: parseFloat(parts[3]) || 0,
    spectralType: parts[4] || '',
    size: parts[5] || '',
  };
}

// Extracts the primary spectral class letter (O B A F G K M L T Y W D C X).
export function getSpectralClass(spectralType) {
  if (!spectralType) return '';
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
