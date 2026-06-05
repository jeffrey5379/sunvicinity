import * as THREE from "./build/three.module.js";

// ══════════════════════════════════════════════════════════════════════════════
//  PARAMETERS — edit these to tune the visual appearance
// ══════════════════════════════════════════════════════════════════════════════
const StarVisualsConfig = {

  // ── Visibility ──────────────────────────────────────────────────────────────
  visRadius:  80.0,   // ly — stars beyond this distance from OrbitControls target are hidden
  fadeBand:   15.0,   // ly — fade starts this many ly before visRadius

  // ── Halo ────────────────────────────────────────────────────────────────────
  haloSize:        1.0,   // multiplier for halo spread (0.1 = tight, 2.0 = very wide)
  haloAmount:      0.4,   // halo brightness (0 = no halo, 1 = very bright)
  haloFadeBelow:   2.0,   // ly — halo fades out smoothly at camera distance <= this value

  // ── Core ────────────────────────────────────────────────────────────────────
  coreWidth:  0.2,    // multiplier for Moffat PSF core radius (0.5 = sharp, 3.0 = bloated)

  // ── Diffraction spikes ──────────────────────────────────────────────────────
  spikeLength:    0.01,   // spike length scale (0 = no spikes, 1.0 = very long)
  spikeWidth:     0.5,   // spike width multiplier (0.5 = razor thin, 4.0 = wide)
  spikeAngle:     0.0,   // rotation in degrees (0 = H+V, 45 = diagonal X)
  spikeFadeBelow: 5.0,   // ly — spikes fade out smoothly at camera distance <= this value

  // ── Colors by spectral class ────────────────────────────────────────────────
  // Override mesh.material.color with calibrated spectral colors for glow/spikes.
  // Values are linear RGB 0–1, tuned to match real star photography.
  // Set to null to use mesh.material.color as-is (original app color).
  spectralColors: {
    O: { r: 0.61, g: 0.70, b: 1.00 },  // hot blue
    B: { r: 0.67, g: 0.75, b: 1.00 },  // blue-white
    A: { r: 0.84, g: 0.88, b: 1.00 },  // white-blue
    F: { r: 0.98, g: 0.96, b: 1.00 },  // yellow-white
    G: { r: 1.00, g: 0.93, b: 0.78, glowMaxDist: 30.0 },  // solar yellow
    K: { r: 0.10, g: 0.90, b: 0.10, glowMaxDist: 10.0 },  // orange
    M: { r: 1.00, g: 0.35, b: 0.15, noGlow: true },  // red dwarf — no glow
    C: { r: 0.90, g: 0.25, b: 0.08, noGlow: true },  // carbon star — no glow
    L: { r: 0.80, g: 0.20, b: 0.05, noGlow: true },  // brown dwarf — no glow
    T: { r: 0.70, g: 0.15, b: 0.05, noGlow: true },  // T-dwarf — no glow
    W: { r: 0.71, g: 0.82, b: 1.00 },  // Wolf-Rayet blue
    D: { r: 0.78, g: 0.86, b: 1.00 },  // white dwarf
    _default: null, // fallback
  },

  // ── Brightness by spectral class ────────────────────────────────────────────
  // Multiplier applied to the brightness derived from mesh scale.
  // Range 0.0–2.0. Reflects real luminosity differences between star types:
  // hot blue giants (O, B) are intrinsically far brighter than red dwarfs (M).
  spectralBrightness: {
    O: 2.0,   // O-type: blue supergiants, extremely luminous
    B: 1.7,   // B-type: blue-white giants (Rigel, Spica)
    A: 1.4,   // A-type: white stars (Vega, Sirius)
    F: 1.2,   // F-type: yellow-white (Procyon, Canopus)
    G: 0.5,   // G-type: solar analog — reference value
    K: 0.3,   // K-type: orange stars (Arcturus, Aldebaran)
    M: 0.25,  // M-type: red dwarfs, intrinsically dim
    C: 0.2,   // C-type: carbon stars
    W: 1.9,   // Wolf-Rayet: extremely hot and luminous
    D: 0.6,   // White dwarfs: small but hot
    _default: 1.0,  // fallback for unknown spectral types
  },

};
// ══════════════════════════════════════════════════════════════════════════════

const StarVisuals = (() => {

  // ── State ─────────────────────────────────────────────────────────────────────
  let _scene, _camera, _controls;
  let _points        = null;
  let _uniforms      = null;
  const _lastTargetPos = new THREE.Vector3(Infinity);

  // ── Shaders ───────────────────────────────────────────────────────────────────

  const VERT = /* glsl */`
    attribute float aBrightness;
    attribute vec3  aColor;
    attribute float aGlowMaxDist;

    uniform vec3  uTarget;
    uniform vec3  uCamPos;
    uniform float uVisRadius;
    uniform float uFadeBand;
    uniform float uPixelRatio;

    varying float vBrightness;
    varying vec3  vColor;
    varying float vFade;
    varying float vDistFromTarget; // distance to OrbitControls target (visibility culling)
    varying float vDistFromCam;    // distance to camera (near-fade + spike fade)
    varying float vGlowMaxDist;    // per-star glow fade distance

    void main() {
      vBrightness = aBrightness;
      vColor      = aColor;

      vec4  worldPos       = modelMatrix * vec4(position, 1.0);
      float distFromTarget = length(worldPos.xyz - uTarget);
      vDistFromTarget      = distFromTarget;
      vDistFromCam         = length(worldPos.xyz - uCamPos);
      vGlowMaxDist         = aGlowMaxDist;

      float inner = uVisRadius - uFadeBand;
      vFade = 1.0 - clamp((distFromTarget - inner) / uFadeBand, 0.0, 1.0);

      if (distFromTarget > uVisRadius || vFade < 0.001) {
        gl_PointSize = 0.0;
        gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }

      vec4 mvPos  = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPos;

      float depth    = -mvPos.z;
      float baseSize = 4.0 + aBrightness * 160.0;
      float sized    = baseSize / max(depth * 0.012, 1.0);
      gl_PointSize   = clamp(sized, 2.0, 220.0) * uPixelRatio;
    }
  `;

  // Fragment shader — parameters are injected as #define so GLSL compiler
  // can optimise them as constants while still being editable from JS config.
  function buildFragShader(cfg) {
    const angleRad = (cfg.spikeAngle * Math.PI / 180).toFixed(6);
    return /* glsl */`
    precision highp float;

    varying float vBrightness;
    varying vec3  vColor;
    varying float vFade;
    varying float vDistFromTarget;
    varying float vDistFromCam;
    varying float vGlowMaxDist;

    #define HALO_SIZE        ${cfg.haloSize.toFixed(4)}
    #define HALO_AMOUNT      ${cfg.haloAmount.toFixed(4)}
    #define HALO_FADE_BELOW  ${cfg.haloFadeBelow.toFixed(4)}
    #define CORE_WIDTH       ${cfg.coreWidth.toFixed(4)}
    #define SPIKE_LENGTH     ${cfg.spikeLength.toFixed(4)}
    #define SPIKE_WIDTH      ${cfg.spikeWidth.toFixed(4)}
    #define SPIKE_ANGLE      ${angleRad}
    #define SPIKE_FADE_BELOW ${cfg.spikeFadeBelow.toFixed(4)}

    float moffat(float r, float a, float b) {
      float u = r / a;
      return pow(1.0 + u * u, -b);
    }

    float spike(vec2 q, vec2 d, float slen, float sw) {
      float along = dot(q, d);
      float perp  = dot(q, vec2(-d.y, d.x));
      if (along < 0.0) return 0.0;
      return (1.0 / max(along / slen + 1.0, 1.0)) * exp(-perp * perp / (sw * sw));
    }

    void main() {
      vec2  p = gl_PointCoord - 0.5;
      float r = length(p);
      if (r > 0.5) discard;

      float b = vBrightness;

      // ── Halo ──────────────────────────────────────────────────────────────
      float haloSigma = HALO_SIZE * 0.18;
      float haloFade  = smoothstep(0.0, HALO_FADE_BELOW, vDistFromCam);
      float halo = HALO_AMOUNT * haloFade * exp(-r * r / (haloSigma * haloSigma));

      // ── Diffraction spikes ─────────────────────────────────────────────────
      float spikeFade = smoothstep(0.0, SPIKE_FADE_BELOW, vDistFromCam);
      float spikeVal  = 0.0;

      if (b > 0.1 && SPIKE_LENGTH > 0.001 && spikeFade > 0.001) {
        float slen = (1.2 + b * 4.0) * SPIKE_LENGTH;
        float sw   = (0.018 + b * 0.014) * SPIKE_WIDTH;

        float cr = cos(SPIKE_ANGLE), sr = sin(SPIKE_ANGLE);
        vec2 dirs[4];
        dirs[0] = vec2( cr,  sr);
        dirs[1] = vec2(-cr, -sr);
        dirs[2] = vec2(-sr,  cr);
        dirs[3] = vec2( sr, -cr);

        for (int i = 0; i < 4; i++) {
          spikeVal += spike(p, dirs[i], slen, sw);
        }
        spikeVal = clamp(spikeVal * (0.6 + b * 0.5), 0.0, 1.0);

        // Secondary fringe
        if (b > 0.4) {
          float fs = 0.0;
          for (int i = 0; i < 4; i++) {
            fs += spike(p, dirs[i], slen * 0.55, sw * 1.8);
          }
          float fm = smoothstep(0.28 * slen, 0.35 * slen, r)
                   * (1.0 - smoothstep(0.52 * slen, 0.60 * slen, r));
          spikeVal += fm * clamp(fs * 0.3 * (b - 0.4), 0.0, 0.25);
        }

        spikeVal *= spikeFade;
      }

      // ── Airy ring ──────────────────────────────────────────────────────────
      float airy = 0.0;
      if (b > 0.45) {
        float ar = 0.10 + b * 0.06;
        float aw = 0.012;
        airy = exp(-pow(abs(r - ar), 2.0) / (aw * aw)) * (b - 0.45) * 0.5;
      }

      // ── Moffat PSF core ────────────────────────────────────────────────────
      float ca    = (0.04 + b * 0.06) * CORE_WIDTH;
      float core  = moffat(r, ca, 2.5);
      float sat   = smoothstep(0.0, ca * 3.0, r);
      vec3  coreC = mix(vec3(1.0), vColor, sat);

      // ── Saturated punch ────────────────────────────────────────────────────
      float punch = 0.0;
      if (b > 0.55) {
        punch = exp(-r * r / (0.022 * 0.022)) * (b - 0.55) * 2.5;
      }

      // ── Composite ──────────────────────────────────────────────────────────
      vec3 col = vColor * (halo + spikeVal + airy)
               + coreC  * core * (0.5 + b * 0.7)
               + vec3(1.0) * punch;

      col = clamp(col, 0.0, 1.5);
      col = col / (col + 0.6);

      float nearFade    = clamp(vDistFromCam / 1.5, 0.0, 1.0);
      // Per-star glow distance fade: smoothly disappear over a 20 ly band
      float glowDistFade = 1.0 - smoothstep(vGlowMaxDist - 20.0, vGlowMaxDist, vDistFromCam);
      float alpha    = clamp(
        halo + spikeVal * 0.8 + airy + core * (0.5 + b * 0.7) + punch,
        0.0, 1.0
      ) * vFade * nearFade * glowDistFade;

      if (alpha < 0.004) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `;}

  // ── Build ONE Points object from all star meshes ──────────────────────────────
  function build(starMeshes) {
    if (_points) {
      _scene.remove(_points);
      _points.geometry.dispose();
      _points.material.dispose();
      _points = null;
    }

    const positions    = [];
    const brightnesses = [];
    const colors       = [];
    const glowMaxDists = [];

    for (const mesh of starMeshes) {
      if (!mesh.position || !mesh.name || !mesh.scale) continue;

      const sc         = mesh.scale.x || 0.01;
      const rawBright  = Math.max(0.05, Math.min(1.0, Math.pow(sc / 0.04, 0.5)));

      // Spectral class brightness multiplier
      let spectralPrefix = '_default';
      if (mesh.data) {
        const sp = (mesh.data.split('|')[4] || '').trim();
        if (sp.length > 0) spectralPrefix = sp[0].toUpperCase();
      }
      const sbTable     = StarVisualsConfig.spectralBrightness;
      const sbMult      = sbTable[spectralPrefix] !== undefined
        ? sbTable[spectralPrefix]
        : sbTable['_default'];
      const brightness  = Math.max(0.05, Math.min(1.0, rawBright * sbMult));

      // Color: use calibrated spectralColors table if defined for this class,
      // otherwise fall back to mesh.material.color (original app color).
      let r = 1.0, g = 0.929, b = 0.784;
      const scTable  = StarVisualsConfig.spectralColors;
      const scEntry  = scTable[spectralPrefix] !== undefined
        ? scTable[spectralPrefix]
        : scTable['_default'];
      if (scEntry) {
        r = scEntry.r; g = scEntry.g; b = scEntry.b;
      } else if (mesh.material && mesh.material.color) {
        r = mesh.material.color.r;
        g = mesh.material.color.g;
        b = mesh.material.color.b;
      }

      // noGlow: skip this star entirely — no sprite added to the Points object
      if (scEntry && scEntry.noGlow) continue;

      positions.push(mesh.position.x, mesh.position.y, mesh.position.z);
      brightnesses.push(brightness);
      colors.push(r, g, b);
      const glowMaxDist = (scEntry && scEntry.glowMaxDist != null)
        ? scEntry.glowMaxDist : 500.0;
      glowMaxDists.push(glowMaxDist);
    }

    const geo     = new THREE.BufferGeometry();
    const setAttr = geo.setAttribute
      ? geo.setAttribute.bind(geo)
      : geo.addAttribute.bind(geo);

    setAttr('position',      new THREE.Float32BufferAttribute(positions,    3));
    setAttr('aBrightness',   new THREE.Float32BufferAttribute(brightnesses, 1));
    setAttr('aColor',        new THREE.Float32BufferAttribute(colors,       3));
    setAttr('aGlowMaxDist',  new THREE.Float32BufferAttribute(glowMaxDists, 1));

    const target = _controls ? _controls.target : new THREE.Vector3();
    const cfg    = StarVisualsConfig;

    _uniforms = {
      uTarget:     { value: target.clone() },
      uCamPos:     { value: new THREE.Vector3() },
      uVisRadius:  { value: cfg.visRadius },
      uFadeBand:   { value: cfg.fadeBand },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms:       _uniforms,
      vertexShader:   VERT,
      fragmentShader: buildFragShader(cfg),
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
      depthTest:      true,
    });

    _points = new THREE.Points(geo, mat);
    _points.renderOrder = 2;
    _points.raycast = () => {};
    _scene.add(_points);

    console.log(`[StarVisuals] Built ${positions.length / 3} stars — 1 draw call.`);
    console.log('[StarVisuals] Config:', cfg);
  }

  // ── Per-frame update ──────────────────────────────────────────────────────────
  function update() {
    if (!_uniforms || !_controls) return;
    const t = _controls.target;
    if (_lastTargetPos.distanceTo(t) > 0.0001) {
      _uniforms.uTarget.value.copy(t);
      _lastTargetPos.copy(t);
    }
    // Always sync camera position — it changes every frame during orbit/pan/zoom
    if (_camera) {
      _uniforms.uCamPos.value.copy(_camera.position);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function init({ scene, camera, controls, stars }) {
    _scene    = scene;
    _camera   = camera;
    _controls = controls || null;
    build(stars);
  }

  function rebuild(stars) { if (_scene) build(stars); }

  return { init, update, rebuild };

})();

window.StarVisuals   = StarVisuals;
window.StarVisualsConfig = StarVisualsConfig;
