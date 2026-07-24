# Sun Vicinity — 3D Neighborhood Explorer

An interactive 3D visualization of the Sun's stellar neighborhood, built with Three.js. Explore ~2.8 mln real stars from the SIMBAD catalog, visit the galactic center with its S-cluster orbits and black hole, and navigate with an AI agent.

## Features

- **3D star map** — real catalog data with spectral-class colors and screen-space size scaling
- **S-cluster simulation** — Keplerian orbits of stars around Sgr A* (Gillessen+2017 elements), advancing in real time with animation toggle
- **AI agent** — Anthropic-powered chat assistant that can fly the camera to any star, plan tours, search by spectral type, and answer questions about the dataset

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome (recommended for best WebGL performance).

## AI Agent

Example prompts:
- *"Fly me to Betelgeuse"*
- *"Show me the nearest red dwarfs"*
- *"Plan a tour of the 5 brightest stars"*

## GUI Panel

- **Show S-cluster** — toggle S-cluster star meshes and orbit ellipses
- **Animate S-cluster** — advance orbits in real time
- **Show constellations** — toggle constellation line labels
- **Show density** — toggle background star density overlay
- **Fly to Sun / Fly to Sgr A*** — reset camera to Sun or galactic center
- **Search** — jump to any star by name

## Tech Stack

- [Three.js](https://threejs.org/) r184 — 3D rendering
- [lil-gui](https://lil-gui.georgealways.com/) — control panel
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Vitest](https://vitest.dev/) — unit tests
- [Anthropic API](https://docs.anthropic.com/) — AI agent

## Data Sources

Star data from the [SIMBAD database](https://simbad.u-strasbg.fr/), CDS, Strasbourg Astronomical Observatory, France.
S-cluster orbital elements from Gillessen et al. (2017).
