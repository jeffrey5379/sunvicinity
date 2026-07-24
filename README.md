# Sun Vicinity — 3D Star Neighborhood Explorer

An interactive 3D visualization of the Sun's stellar neighborhood, built with Three.js. Explore ~10,000 real stars from the SIMBAD catalog, visit the galactic center with its S-cluster orbits and Interstellar-style black hole, and navigate with an AI guide — Captain Snail Lightchaser.

## Features

- **3D star map** — real catalog data with spectral-class colors and screen-space size scaling
- **Two modes** — Exploratory (guided constellation/star quiz) and Free (open navigation)
- **S-cluster simulation** — Keplerian orbits of stars around Sgr A* (Gillessen+2017 elements), advancing in real time with animation toggle
- **Interstellar-style black hole** — accretion disk with gravitational lensing effect and distance HUD
- **Star glows** — billboard far-glow sprites, scaled per spectral class with per-class hide distances
- **AI agent (Captain Snail Lightchaser)** — Anthropic-powered chat assistant that can fly the camera to any star, plan tours, search by spectral type, and answer questions about the dataset
- **Constellation labels** — in-scene 3D text, with a quiz mode to find misplaced names

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome (recommended for best WebGL performance).

## Controls

| Action | Control |
|--------|---------|
| Orbit camera | Left-click drag |
| Zoom | Scroll wheel |
| Click star | Fly camera to that star |
| Click black hole | Fly camera to Sgr A* |

## AI Agent

Click the snail icon (bottom-left) to open the chat panel. Paste your [Anthropic API key](https://console.anthropic.com/) to activate. The key is stored only in the current tab's memory.

Example prompts:
- *"Fly me to Betelgeuse"*
- *"Show me the nearest red dwarfs"*
- *"Plan a tour of the 5 brightest stars"*

## GUI Panel

- **Show S-cluster** — toggle S-cluster star meshes and orbit ellipses
- **Animate S-cluster** — advance orbits in real time (year counter shown)
- **Show constellations** — toggle constellation line labels
- **Show density** — toggle background star density overlay
- **Fly to Sun / Fly to Sgr A*** — reset camera to Sun or galactic center
- **Search** — jump to any star by name

## Project Structure

```
index.html        — main app, scene setup, GUI, click/animation logic
agent.js          — Captain Snail Lightchaser AI chat panel
blackhole.js      — Interstellar-style black hole renderer
s_cluster.js      — S-cluster Keplerian orbit simulation
visuals.js        — star glow (StarVisuals) and far-glow billboard system
nebula.js         — background nebula particle effect
utils.js          — coordinate helpers (parallax → ly, degrees → rad)
files/            — star catalog, constellation, cluster, and S-cluster data
public/           — static assets (fonts, audio, images)
tests/            — Vitest unit tests
```

## Tech Stack

- [Three.js](https://threejs.org/) r184 — 3D rendering
- [lil-gui](https://lil-gui.georgealways.com/) — control panel
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Vitest](https://vitest.dev/) — unit tests
- [Anthropic API](https://docs.anthropic.com/) — AI agent

## Data Sources

Star data from the [SIMBAD database](https://simbad.u-strasbg.fr/), CDS, Strasbourg Astronomical Observatory, France.
S-cluster orbital elements from Gillessen et al. (2017).

## License

See [LICENSE](LICENSE).
