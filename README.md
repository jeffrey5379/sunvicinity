# Sun Vicinity

An interactive 3D visualization of the Sun's stellar neighborhood. Explore real stars from Gaia DR3 and SIMBAD, fly out to the galactic center with its S-cluster orbits around Sgr A\*, and switch on a 3D star-density map.

## Features

- **3D star map** — real catalog data with spectral-class colors and screen-space size scaling
- **Density map** — 3D star-density grid with a raymarched Milky Way; click a cell to fly to the nearest bright star
- **S-cluster simulation** — Keplerian orbits of stars around Sgr A\* (Gillessen+2017 elements), advancing in real time with an animation toggle
- **AI agent** — Anthropic-powered chat assistant that can fly the camera to any star, plan tours, search by spectral type, and answer questions about the dataset

## Getting Started

```bash
npm install
npm run server   # data API — the client fetches stars from this, in a separate terminal
npm run dev
```

Open `http://localhost:5173` in Chrome (recommended for best WebGL performance). Requires `scripts/stardata.db` — see [Updating Star Data](#updating-star-data).

## UI

- **Show / Animate S-cluster** — S-cluster star meshes + orbit ellipses; advance orbits in real time
- **Show constellations** — toggle constellation line labels
- **Show density** — toggle the 3D density map
- **Fly to Sun / Fly to Sgr A\*** — reset camera to Sun or galactic center
- **Search** — jump to any star by name (press Enter)

## AI Agent

Example prompts:
- *"Fly me to Betelgeuse"*
- *"Show me the nearest red dwarfs"*
- *"Plan a tour of the 5 brightest stars"*

## Tech Stack

- [Three.js](https://threejs.org/) r184 — 3D rendering
- [lil-gui](https://lil-gui.georgealways.com/) — control panel
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Vitest](https://vitest.dev/) — unit tests
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — catalog store, with R-Tree spatial queries
- [Anthropic API](https://docs.anthropic.com/) — AI agent

## Data Sources

Star positions from [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3), ESA. Object type, spectral type, and names from the [SIMBAD database](https://simbad.u-strasbg.fr/), CDS, Strasbourg. S-cluster orbital elements from Gillessen et al. (2017).
