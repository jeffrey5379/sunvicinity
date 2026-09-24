// Single source of truth for the density-grid voxel size — shared between
// the offline build script (scripts/build-density-grid.js) and the client
// renderer (density_map.js), so the two never need to be kept in sync by
// hand. Change it here, then rerun `npm run build:density-grid`.
export const DENSITY_CELL_SIZE_LY = 100;

// Colour bands for the density cells, keyed by absolute star count per cell
// (not a fraction of the busiest cell — that skews badly, since one hotspot
// cell can dwarf everything else). Each cell's raw count picks the first
// band whose [min, max] contains it; density_map.js applies `opacity` to
// `color` to get the actual (dimmed) cell colour, brightest at the top.
//
// Boundaries below were picked from the actual distribution in
// files/density-grid.bin at cellSize=100 (see percentiles: p50=73, p75=177,
// p90=336, p95=465, p99=811, p99.9=1645) — rerun the analysis and adjust
// after changing DENSITY_CELL_SIZE_LY or resyncing, since the shape of the
// distribution shifts with both.
export const DENSITY_BANDS = [
  { min: 0,    max: 199,      color: 0xffffff, opacity: 0.1 }, // white
  { min: 200,  max: 499,      color: 0xffff00, opacity: 0.3 }, // yellow
  { min: 500,  max: 999,      color: 0xffa500, opacity: 0.7 }, // orange
  { min: 1000, max: 1499,     color: 0xcc6600, opacity: 0.9 }, // dark orange
  { min: 1500, max: Infinity, color: 0xff0000, opacity: 1.0 }, // red
];
