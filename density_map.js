import * as THREE from "three";
import { DENSITY_CELL_SIZE_LY, DENSITY_BANDS } from "./density-grid-config.js";

const HEADER_BYTES = 8; // uint32 cellCount, uint32 maxCount

export async function loadDensityGrid(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`density grid fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const cellCount = dv.getUint32(0, true);
  const maxCount = dv.getUint32(4, true);

  const ix = new Int32Array(buf, HEADER_BYTES, cellCount);
  const iy = new Int32Array(buf, HEADER_BYTES + cellCount * 4, cellCount);
  const iz = new Int32Array(buf, HEADER_BYTES + cellCount * 8, cellCount);
  const n = new Uint32Array(buf, HEADER_BYTES + cellCount * 12, cellCount);

  return { cellSizeLy: DENSITY_CELL_SIZE_LY, cellCount, maxCount, ix, iy, iz, n };
}

// THREE.Color instances for each band, built once from the plain hex values
// in density-grid-config.js (kept dependency-free there since the Node
// build script reads the same file).
const BAND_COLORS = DENSITY_BANDS.map((b) => new THREE.Color(b.color));

// Bands are keyed by absolute star count per cell — see density-grid-
// config.js for why (a fraction of the busiest cell skews badly).
function pickBandIndex(count) {
  for (let k = 0; k < DENSITY_BANDS.length; k++) {
    if (count >= DENSITY_BANDS[k].min && count <= DENSITY_BANDS[k].max) return k;
  }
  // Outside every band (e.g. negative, or a gap left by hand-edited
  // boundaries) — clamp to the nearest edge rather than crash.
  return count < DENSITY_BANDS[0].min ? 0 : DENSITY_BANDS.length - 1;
}

// Swatch colours for the density colour-filter checkboxes — each band's
// colour dimmed by its opacity, i.e. the actual colour written to the cells.
export const DENSITY_BAND_COLORS = DENSITY_BANDS.map(
  (b, i) => "#" + BAND_COLORS[i].clone().multiplyScalar(b.opacity).getHexString()
);

function dimmedRampColor(count, out) {
  const idx = pickBandIndex(count);
  return out.copy(BAND_COLORS[idx]).multiplyScalar(DENSITY_BANDS[idx].opacity);
}

// The same band's colour at full brightness, dimming undone — used for
// the hover highlight (see highlightDensityCell): "fully opaque" here
// means undoing that same per-band dimming trick, not changing hue.
function fullRampColor(count, out) {
  return out.copy(BAND_COLORS[pickBandIndex(count)]);
}

const HOVER_SCALE = 1.2;
const _scratchColor = new THREE.Color();
const _scratchMatrix = new THREE.Matrix4();

const CELL_FILL_FRACTION = 0.05;

export function buildDensityMapGroup(grid) {
  const { cellSizeLy, cellCount, ix, iy, iz, n } = grid;
  const group = new THREE.Group();
  group.name = "densityMap";

  const boxSize = cellSizeLy * CELL_FILL_FRACTION;
  const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, cellCount);
  mesh.name = "densityCells";
  mesh.frustumCulled = false;

  const cellCenters = new Float32Array(cellCount * 3);
  const fullColors = new Float32Array(cellCount * 3);
  const bands = new Uint8Array(cellCount);

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  matrix.identity(); // every box is the same size — only colour encodes density
  for (let i = 0; i < cellCount; i++) {
    const count = n[i];
    const cx = (ix[i] + 0.5) * cellSizeLy, cy = (iy[i] + 0.5) * cellSizeLy, cz = (iz[i] + 0.5) * cellSizeLy;
    cellCenters[i * 3] = cx;
    cellCenters[i * 3 + 1] = cy;
    cellCenters[i * 3 + 2] = cz;
    matrix.setPosition(cx, cy, cz);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, dimmedRampColor(count, color));
    bands[i] = pickBandIndex(count);
    fullRampColor(count, color);
    fullColors[i * 3] = color.r;
    fullColors[i * 3 + 1] = color.g;
    fullColors[i * 3 + 2] = color.b;
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.userData.cellCenters = cellCenters;
  mesh.userData.baseColors = mesh.instanceColor.array.slice();
  mesh.userData.fullColors = fullColors;
  mesh.userData.bands = bands;
  // Pristine per-instance colours — baseColors gets zeroed per band as the
  // colour filter hides bands; this keeps the originals to restore from.
  mesh.userData.pristineColors = mesh.instanceColor.array.slice();
  mesh.userData.bandVisible = DENSITY_BANDS.map(() => true);
  group.add(mesh);

  // The Milky Way backdrop (milkyway.js) is static and shared with the
  // normal scene — index.html adds one instance directly to the scene and
  // keeps it out of the swap when entering/leaving density mode, so it's
  // already there and this group doesn't need its own copy.

  return group;
}

export function getDensityCellCenter(mesh, instanceId, target = new THREE.Vector3()) {
  return target.fromArray(mesh.userData.cellCenters, instanceId * 3);
}

export function setDensityBandVisible(mesh, bandIndex, visible) {
  const ud = mesh.userData;
  if (!ud.bands) return;
  ud.bandVisible[bandIndex] = visible;
  const bands = ud.bands, base = ud.baseColors, pristine = ud.pristineColors;
  const live = mesh.instanceColor.array;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] !== bandIndex) continue;
    const o = i * 3;
    const r = visible ? pristine[o] : 0;
    const g = visible ? pristine[o + 1] : 0;
    const b = visible ? pristine[o + 2] : 0;
    base[o] = r; base[o + 1] = g; base[o + 2] = b;
    live[o] = r; live[o + 1] = g; live[o + 2] = b;
  }
  mesh.instanceColor.needsUpdate = true;
}

export function highlightDensityCell(mesh, instanceId) {
  const c = mesh.userData.cellCenters;
  _scratchMatrix.makeScale(HOVER_SCALE, HOVER_SCALE, HOVER_SCALE);
  _scratchMatrix.setPosition(c[instanceId * 3], c[instanceId * 3 + 1], c[instanceId * 3 + 2]);
  mesh.setMatrixAt(instanceId, _scratchMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  _scratchColor.fromArray(mesh.userData.fullColors, instanceId * 3);
  mesh.setColorAt(instanceId, _scratchColor);
  mesh.instanceColor.needsUpdate = true;
}

export function clearDensityHighlight(mesh, instanceId) {
  const c = mesh.userData.cellCenters;
  _scratchMatrix.identity();
  _scratchMatrix.setPosition(c[instanceId * 3], c[instanceId * 3 + 1], c[instanceId * 3 + 2]);
  mesh.setMatrixAt(instanceId, _scratchMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  _scratchColor.fromArray(mesh.userData.baseColors, instanceId * 3);
  mesh.setColorAt(instanceId, _scratchColor);
  mesh.instanceColor.needsUpdate = true;
}
