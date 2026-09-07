import * as THREE from "three";
import { buildMilkyWayGroup } from "./milkyway.js";

const FORMAT_VERSION = 1;
const HEADER_BYTES = 20;

export async function loadDensityGrid(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`density grid fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const formatVersion = dv.getUint32(0, true);
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`density grid format ${formatVersion} unsupported (expected ${FORMAT_VERSION})`);
  }
  const cellSizeLy = dv.getFloat32(4, true);
  const radiusLy = dv.getFloat32(8, true);
  const cellCount = dv.getUint32(12, true);
  const maxCount = dv.getUint32(16, true);

  const ix = new Int32Array(buf, HEADER_BYTES, cellCount);
  const iy = new Int32Array(buf, HEADER_BYTES + cellCount * 4, cellCount);
  const iz = new Int32Array(buf, HEADER_BYTES + cellCount * 8, cellCount);
  const n = new Uint32Array(buf, HEADER_BYTES + cellCount * 12, cellCount);

  return { cellSizeLy, radiusLy, cellCount, maxCount, ix, iy, iz, n };
}

const RAMP_BANDS = [
  { min: 0.0, opacity: 0.1, color: new THREE.Color(0xffffff) }, // 0-20%: white, most transparent
  { min: 0.2, opacity: 0.3, color: new THREE.Color(0xffff00) }, // 20-40%: yellow
  { min: 0.4, opacity: 0.7, color: new THREE.Color(0xffa500) }, // 40-60%: light orange
  { min: 0.6, opacity: 0.9, color: new THREE.Color(0xcc6600) }, // 60-80%: dark orange
  { min: 0.8, opacity: 1.0, color: new THREE.Color(0xff0000) },  // 80-100%: red, least transparent
];

function pickBand(t) {
  const clamped = Math.min(Math.max(t, 0), 1);
  let band = RAMP_BANDS[0];
  for (const candidate of RAMP_BANDS) {
    if (clamped >= candidate.min) band = candidate;
  }
  return band;
}

function dimmedRampColor(t, out) {
  const band = pickBand(t);
  return out.copy(band.color).multiplyScalar(band.opacity);
}

// The same band's colour at full brightness, dimming undone — used for
// the hover highlight (see highlightDensityCell): "fully opaque" here
// means undoing that same per-band dimming trick, not changing hue.
function fullRampColor(t, out) {
  return out.copy(pickBand(t).color);
}

const HOVER_SCALE = 1.2;
const _scratchColor = new THREE.Color();
const _scratchMatrix = new THREE.Matrix4();

const CELL_FILL_FRACTION = 0.05;

export function buildDensityMapGroup(grid) {
  const { cellSizeLy, radiusLy, cellCount, maxCount, ix, iy, iz, n } = grid;
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

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const maxCountDenom = maxCount || 1;
  matrix.identity(); // every box is the same size — only colour encodes density
  for (let i = 0; i < cellCount; i++) {
    const t = n[i] / maxCountDenom;
    const cx = (ix[i] + 0.5) * cellSizeLy, cy = (iy[i] + 0.5) * cellSizeLy, cz = (iz[i] + 0.5) * cellSizeLy;
    cellCenters[i * 3] = cx;
    cellCenters[i * 3 + 1] = cy;
    cellCenters[i * 3 + 2] = cz;
    matrix.setPosition(cx, cy, cz);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, dimmedRampColor(t, color));
    fullRampColor(t, color);
    fullColors[i * 3] = color.r;
    fullColors[i * 3 + 1] = color.g;
    fullColors[i * 3 + 2] = color.b;
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.userData.cellCenters = cellCenters;
  mesh.userData.baseColors = mesh.instanceColor.array.slice();
  mesh.userData.fullColors = fullColors;
  group.add(mesh);

  const boundary = new THREE.Mesh(
    new THREE.SphereGeometry(radiusLy, 32, 20),
    new THREE.MeshBasicMaterial({ color: 0x909090, wireframe: true, transparent: true, opacity: 0.12 }),
  );
  group.add(boundary);

  // Simplified Milky Way backdrop (see milkyway.js) — same group, same
  // additive/no-depth-write treatment as the cells above, so it renders
  // together with them rather than as a separately toggled layer.
  group.add(buildMilkyWayGroup());

  return group;
}

export function getDensityCellCenter(mesh, instanceId, target = new THREE.Vector3()) {
  return target.fromArray(mesh.userData.cellCenters, instanceId * 3);
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
