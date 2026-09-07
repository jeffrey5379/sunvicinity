import * as THREE from "three";
import { lumClassMult, giantBrightnessMult, maxVisibilityDistance } from "./utils.js";

// ══════════════════════════════════════════════════════════════════════════════
//  PARAMETERS — edit these to tune the visual appearance
// ══════════════════════════════════════════════════════════════════════════════
const StarVisualsConfig = {
  // ── Visibility ──────────────────────────────────────────────────────────────
  visRadius: 100.0, // ly — stars beyond this distance from OrbitControls target are hidden
  fadeBand: 15.0, // ly — fade starts this many ly before visRadius

  // ── Brightness ──────────────────────────────────────────────────────────────
  // Multiplier applied on top of the raw mesh-scale brightness, independent of
  // DEFAULT_RADIUS — use this to re-tune overall star brightness after changing
  // DEFAULT_RADIUS instead of relying on mesh size. Affects both the far-field
  // glow/points system and the close-up billboard system (near and far alike).
  globalBrightnessBoost: 2.0,

  // ── Halo ────────────────────────────────────────────────────────────────────
  haloSize: 1.0, // multiplier for halo spread (0.1 = tight, 2.0 = very wide)
  haloAmount: 0.6, // halo brightness (0 = no halo, 1 = very bright)
  haloFadeBelow: 0.0, // ly — halo fades out smoothly at camera distance <= this value
  haloFadeAbove: 150.0, // ly — halo fades out smoothly at camera distance >= this value

  // ── Core ────────────────────────────────────────────────────────────────────
  coreWidth: 0.2, // multiplier for Moffat PSF core radius (0.5 = sharp, 3.0 = bloated)

  // ── Diffraction spikes ──────────────────────────────────────────────────────
  spikeLength: 0.02, // spike length scale (0 = no spikes, 1.0 = very long)
  spikeWidth: 0.3, // spike width multiplier (0.5 = razor thin, 4.0 = wide)
  spikeAngle: 0.0, // rotation in degrees (0 = H+V, 45 = diagonal X)
  spikeFadeBelow: 5.0, // ly — spikes fade out smoothly at camera distance <= this value

  // ── Per-class parameters ─────────────────────────────────────────────────────
  spectralParameters: {
    O: { brightness: 2.1 },
    B: { brightness: 1.8 },
    A: { brightness: 1.5 },
    F: { brightness: 1.2 },
    G: { brightness: 0.8 },
    K: { brightness: 0.6 },
    M: { brightness: 0.4, noCoreDisk: true },
    C: { brightness: 0.2, noGlow: true, noCoreDisk: true },
    L: { brightness: 0.1, noGlow: true, noCoreDisk: true },
    T: { brightness: 0.1, noGlow: true, noCoreDisk: true },
    Y: { brightness: 0.1, noGlow: true, noCoreDisk: true },
    W: { brightness: 1.9 },
    D: { brightness: 0.6 },
    _default: { brightness: 0.1, noGlow: true, noCoreDisk: true },
  },
};
// ══════════════════════════════════════════════════════════════════════════════

const StarVisuals = (() => {
  // ── State ─────────────────────────────────────────────────────────────────────
  let _scene, _camera, _controls;
  // { <class letter>: { glowMaxDist?, noGlow? }, defaultGlowMaxDist, closeRangeLy }
  // — fetched by index.html from GET /api/star-visibility-config and passed
  // into init(); see maxVisibilityDistance in utils.js for how it's used.
  let _visibilityConfig = null;
  let _points = null;
  let _uniforms = null;
  const _lastTargetPos = new THREE.Vector3(Infinity);
  const _dynamicSlots = [];  // { mesh, bufStart } for stars with dynamicPosition = true

  // ── Close-star state ──────────────────────────────────────────────────────────
  const _glowStarData = [];
  const _closePool = [];
  const CLOSE_POOL_SIZE = 32;

  // ── Shaders ───────────────────────────────────────────────────────────────────

  const VERT = /* glsl */ `
    attribute float aBrightness;
    attribute vec3  aColor;
    attribute float aGlowMaxDist;

    uniform vec3  uTarget;
    uniform vec3  uTargetCam;
    uniform vec3  uCamPos;
    uniform float uVisRadius;
    uniform float uFadeBand;
    uniform float uPixelRatio;

    varying float vBrightness;
    varying vec3  vColor;
    varying float vFade;
    varying float vDistFromTarget;
    varying float vDistFromCam;
    varying float vGlowMaxDist;
    varying float vDynamic;

    void main() {
      vBrightness = aBrightness;
      vColor      = aColor;
      // Negative aGlowMaxDist signals a dynamic (S-cluster) star; abs value is the real dist.
      vGlowMaxDist = abs(aGlowMaxDist);
      bool isDynamic = aGlowMaxDist < 0.0;
      vDynamic = isDynamic ? 1.0 : 0.0;

      float distFromTarget;
      vec4  mvPos;

      if (isDynamic) {
        // position is already in camera/eye space (CPU computed at float64 precision
        // to avoid float32 cancellation at large world-space distances like S-cluster).
        distFromTarget = length(position.xyz - uTargetCam);
        vDistFromCam   = length(position.xyz);
        mvPos          = vec4(position, 1.0);
      } else {
        vec4 worldPos  = modelMatrix * vec4(position, 1.0);
        distFromTarget = length(worldPos.xyz - uTarget);
        vDistFromCam   = length(worldPos.xyz - uCamPos);
        mvPos          = modelViewMatrix * vec4(position, 1.0);
      }

      vDistFromTarget = distFromTarget;

      float inner = uVisRadius - uFadeBand;
      vFade = 1.0 - clamp((distFromTarget - inner) / uFadeBand, 0.0, 1.0);

      if (distFromTarget > uVisRadius || vFade < 0.001) {
        gl_PointSize = 0.0;
        gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }

      gl_Position = projectionMatrix * mvPos;

      float depth    = -mvPos.z;
      float baseSize = 4.0 + aBrightness * 160.0;
      float sized    = baseSize / max(depth * 0.012, 1.0);
      gl_PointSize   = clamp(sized, 2.0, 350.0) * uPixelRatio;
    }
  `;

  // Fragment shader — parameters are injected as #define so GLSL compiler
  // can optimise them as constants while still being editable from JS config.
  function buildFragShader(cfg) {
    const angleRad = ((cfg.spikeAngle * Math.PI) / 180).toFixed(6);
    return /* glsl */ `
    precision highp float;

    varying float vBrightness;
    varying vec3  vColor;
    varying float vFade;
    varying float vDistFromTarget;
    varying float vDistFromCam;
    varying float vGlowMaxDist;
    varying float vDynamic;

    #define HALO_SIZE        ${cfg.haloSize.toFixed(4)}
    #define HALO_AMOUNT      ${cfg.haloAmount.toFixed(4)}
    #define HALO_FADE_BELOW  ${cfg.haloFadeBelow.toFixed(4)}
    #define HALO_FADE_ABOVE  ${cfg.haloFadeAbove.toFixed(4)}
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
      // sigma and amplitude grow with proximity, matching photographic bloom:
      // at 10 ly: sigma≈0.10, amplitude=HALO_AMOUNT (tight halo)
      // at  1 ly: sigma≈0.32, amplitude≈1.8×HALO_AMOUNT (wide bloom)
      // at 0.3 ly: sigma clamped to 0.44 (fills sprite edge-to-edge)
      float hCloseness  = clamp(10.0 / max(vDistFromCam, 0.3), 1.0, 30.0);
      float haloSigma   = clamp(HALO_SIZE * 0.10 * sqrt(hCloseness), 0.06, 0.44);
      float haloFarFade = 1.0 - smoothstep(HALO_FADE_ABOVE * 0.5, HALO_FADE_ABOVE, vDistFromCam);
      float haloAmp     = HALO_AMOUNT * clamp(pow(hCloseness, 0.25), 1.0, 2.5) * haloFarFade;
      float halo        = haloAmp * exp(-r * r / (haloSigma * haloSigma));

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
        airy = exp(-pow(abs(r - ar), 2.0) / (aw * aw)) * (b - 0.45) * 0.5 * (1.0 - spikeFade);
      }

      // ── Moffat PSF core ────────────────────────────────────────────────────
      // Core gets tighter with distance: far away a star is a sharp point,
      // close up it has a soft photographic spread.
      float caTight = mix(0.03, 1.0, haloFarFade);
      float ca    = (0.04 + b * 0.06) * CORE_WIDTH * caTight;
      float core  = moffat(r, ca, 2.5); 
      float sat   = smoothstep(0.0, ca * 3.0, r);
      vec3  coreC = mix(vec3(1.0), vColor, sat);

      // ── Saturated punch ────────────────────────────────────────────────────
      // Punch is a bloom artifact (over-saturation) — fades with halo.
      float punch = 0.0;
      if (b > 0.55) {
        punch = exp(-r * r / (0.022 * 0.022)) * (b - 0.55) * 2.5 * haloFarFade;
      }

      // ── Composite ──────────────────────────────────────────────────────────
      vec3 col = vColor * (halo + spikeVal + airy)
               + coreC  * core * (0.5 + b * 0.7)
               + vec3(1.0) * punch;

      col = clamp(col, 0.0, 1.5);
      col = col / (col + 0.6);

      float nearFade = clamp(vDistFromCam / 1.5, 0.0, 1.0);
      // Per-star glow distance fade: smoothly disappear over a 20 ly band
      float glowDistFade = 1.0 - smoothstep(vGlowMaxDist - 20.0, vGlowMaxDist, vDistFromCam);
      // Dynamic (S-cluster) stars cross-fade with the close-pool glow billboard:
      // fade the far-star point out as camera approaches (1 at d>=5 ly, 0 at d<=1.5 ly),
      // matching the close-pool glow that fades in over the same range.
      float closeFade = vDynamic > 0.5 ? smoothstep(1.5, 5.0, vDistFromCam) : 1.0;
      float alpha = clamp(
        halo + spikeVal * 0.8 + airy + core * (0.5 + b * 0.7) + punch,
        0.0, 1.0
      ) * vFade * nearFade * glowDistFade * closeFade;

      if (alpha < 0.004) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `;
  }

  // ── Close-star shaders ────────────────────────────────────────────────────────

  const CLOSE_VERT = /* glsl */ `
    uniform vec3  uStarPos;
    uniform float uSize;
    varying vec2  vUv;
    void main() {
      vUv = uv - vec2(0.5);
      // uStarPos is passed in camera/eye space (computed on CPU at float64 precision)
      // to avoid float32 cancellation errors at large world-space distances (~26996 ly).
      vec4 mvPos  = vec4(uStarPos, 1.0);
      gl_Position = projectionMatrix * (mvPos + vec4(position.xy * uSize, 0.0, 0.0));
    }
  `;

  const CLOSE_FRAG = /* glsl */ `
    precision highp float;
    uniform vec3  uColor;
    uniform float uDist;
    uniform float uBrightness;
    uniform float uStarRadius;
    uniform float uDiskAmp;
    varying vec2  vUv;

    void main() {
      vec2  p   = vUv;
      float r   = length(p);
      if (r > 0.5) discard;

      float fade  = 1.0 - smoothstep(1.5, 5.0, uDist);
      if (fade < 0.001) discard;

      float diskR   = max(uStarRadius, 0.003 + uBrightness * 0.010);
      float glowAmp = 0.3 + uBrightness * 0.7;
      float disk    = uDiskAmp * exp(-r * r / (diskR * diskR));
      float glow    = uDiskAmp * glowAmp * exp(-r * r / (diskR * 4.0 * diskR * 4.0));

      // M-type stars (uDiskAmp=0): faint corona ring at star edge + soft outer shell
      float noCore     = 1.0 - uDiskAmp;
      float dr         = r - uStarRadius * 0.95;
      float coronaRing = noCore * glowAmp * 3.0 * exp(-dr * dr / (uStarRadius * 0.7 * uStarRadius * 0.7));
      float outerShell = noCore * glowAmp * 1.5 * exp(-r * r / (diskR * 3.5 * diskR * 3.5));

      // With disk: white-hot center fading to spectral color.
      // Without disk (M and below): pure spectral color throughout.
      vec3  withDisk    = mix(vec3(1.0), uColor, smoothstep(0.0, diskR * 1.5, r));
      vec3  coreColor   = mix(uColor, withDisk, uDiskAmp);
      vec3  col   = coreColor * (disk + glow) * (0.6 + uBrightness * 0.8)
                  + uColor * (coronaRing + outerShell) * (0.6 + uBrightness * 0.8);
      float alpha = clamp((disk + glow + coronaRing + outerShell) * fade, 0.0, 1.0);
      if (alpha < 0.004) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `;

  // ── Build ONE Points object from all star meshes ──────────────────────────────
  function build(starMeshes) {
    if (_points) {
      _scene.remove(_points);
      _points.geometry.dispose();
      _points.material.dispose();
      _points = null;
    }

    _glowStarData.length = 0;
    _dynamicSlots.length = 0;

    const positions = [];
    const brightnesses = [];
    const colors = [];
    const glowMaxDists = [];

    for (const mesh of starMeshes) {
      if (!mesh.position || !mesh.name || !mesh.scale) continue;

      // Use the true nominal radius, not mesh.scale.x — adjustStars() (index.html)
      // mutates .scale to keep distant stars at a minimum on-screen size, which
      // has nothing to do with actual brightness. Reused meshes (S-cluster stars,
      // never recreated by recalculateCache()) can carry a hugely inflated .scale
      // left over from that distance compensation into a rebuild.
      const sc = mesh.initialscale ?? mesh.scale.x ?? 0.01;
      const rawBright = Math.pow(sc / 0.04, 0.5) * StarVisualsConfig.globalBrightnessBoost;

      const spectralClass = mesh.spectralClass || "";
      const lumMult = lumClassMult(mesh.spectralType || "");
      const isGiant = lumMult > 1.0; // true for giants and supergiants

      const spTable = StarVisualsConfig.spectralParameters;
      const spEntry =
        spTable[spectralClass] !== undefined
          ? spTable[spectralClass]
          : spTable["_default"];
      const brightnessLumMult = isGiant ? giantBrightnessMult(mesh.spectralType || "") : 1.0;
      // No upper clamp: brightness is bounded downstream by the shader's own
      // alpha/color clamps (visuals.js VERT/FRAG), so the brightest stars can
      // bloom further instead of being hard-capped at the same value.
      const brightness = Math.max(0.05, rawBright * spEntry.brightness * brightnessLumMult);

      let r = 1.0, g = 0.929, b = 0.784;
      if (mesh.material && mesh.material.color) {
        r = mesh.material.color.r;
        g = mesh.material.color.g;
        b = mesh.material.color.b;
      }
      const noCoreDisk = !!(spEntry && spEntry.noCoreDisk);

      // All stars get the close-up glow billboard
      _glowStarData.push({ pos: mesh.position.clone(), color: new THREE.Color(r, g, b), brightness, starRadius: sc, noCoreDisk, starMesh: mesh });

      // noGlow: skip this star for the far points/halo system
      if (spEntry && spEntry.noGlow && !isGiant) continue;

      if (mesh.dynamicPosition) {
        _dynamicSlots.push({ mesh, bufStart: positions.length });
      }
      positions.push(mesh.position.x, mesh.position.y, mesh.position.z);
      brightnesses.push(brightness);
      colors.push(r, g, b);
      const glowMaxDist = maxVisibilityDistance(mesh.spectralType || "", _visibilityConfig);
      // Negative glowMaxDist signals dynamic (S-cluster) star to the VERT shader.
      glowMaxDists.push(mesh.dynamicPosition ? -glowMaxDist : glowMaxDist);
    }

    const geo = new THREE.BufferGeometry();
    const setAttr = geo.setAttribute
      ? geo.setAttribute.bind(geo)
      : geo.addAttribute.bind(geo);

    setAttr("position", new THREE.Float32BufferAttribute(positions, 3));
    setAttr("aBrightness", new THREE.Float32BufferAttribute(brightnesses, 1));
    setAttr("aColor", new THREE.Float32BufferAttribute(colors, 3));
    setAttr("aGlowMaxDist", new THREE.Float32BufferAttribute(glowMaxDists, 1));

    const target = _controls ? _controls.target : new THREE.Vector3();
    const cfg = StarVisualsConfig;

    _uniforms = {
      uTarget:    { value: target.clone() },
      uTargetCam: { value: new THREE.Vector3() },
      uCamPos:    { value: new THREE.Vector3() },
      uVisRadius: { value: cfg.visRadius },
      uFadeBand:  { value: cfg.fadeBand },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: _uniforms,
      vertexShader: VERT,
      fragmentShader: buildFragShader(cfg),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    _points = new THREE.Points(geo, mat);
    _points.renderOrder = 2;
    _points.frustumCulled = false;
    _points.raycast = () => {};
    _scene.add(_points);
  }

  // ── Close-star billboard pool ─────────────────────────────────────────────────
  function _buildCloseMesh() {
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < CLOSE_POOL_SIZE; i++) {
      const uniforms = {
        uStarPos:    { value: new THREE.Vector3() },
        uColor:      { value: new THREE.Color(1.0, 0.93, 0.78) },
        uSize:       { value: 1.0 },
        uDist:       { value: 999.0 },
        uBrightness: { value: 0.5 },
        uStarRadius: { value: 0.0002 },
        uDiskAmp:    { value: 1.0 },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: CLOSE_VERT,
        fragmentShader: CLOSE_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.raycast = () => {};
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      _scene.add(mesh);
      _closePool.push({ mesh, uniforms });
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────────────
  function update() {
    if (!_uniforms || !_controls) return;

    // matrixWorldInverse is refreshed by renderer.render(), which runs AFTER this
    // function. Force a sync now so all camera-space calculations use the current
    // frame's camera transform, not the previous one.
    if (_camera) _camera.updateMatrixWorld();

    const t = _controls.target;
    if (_lastTargetPos.distanceTo(t) > 0.0001) {
      _uniforms.uTarget.value.copy(t);
      _lastTargetPos.copy(t);
    }
    if (_camera) {
      _uniforms.uCamPos.value.copy(_camera.position);
      // uTargetCam: controls.target in camera/eye space, computed at float64
      // so the GPU receives a small accurate float32 value for dynamic star culling.
      const e = _camera.matrixWorldInverse.elements;
      _uniforms.uTargetCam.value.set(
        e[0]*t.x + e[4]*t.y + e[8]*t.z  + e[12],
        e[1]*t.x + e[5]*t.y + e[9]*t.z  + e[13],
        e[2]*t.x + e[6]*t.y + e[10]*t.z + e[14]
      );
    }

    // Update dynamic (S-cluster) star positions to camera/eye space every frame.
    // Applying the view transform at float64 in JS cancels the large world-space
    // offsets (~26996 ly) before they reach the GPU as float32, eliminating the
    // precision-driven trembling the _points shader would otherwise show.
    if (_points && _dynamicSlots.length > 0 && _camera) {
      const arr = _points.geometry.attributes.position.array;
      const e = _camera.matrixWorldInverse.elements;
      for (const { mesh, bufStart } of _dynamicSlots) {
        const wx = mesh.position.x, wy = mesh.position.y, wz = mesh.position.z;
        arr[bufStart]     = e[0]*wx + e[4]*wy + e[8]*wz  + e[12];
        arr[bufStart + 1] = e[1]*wx + e[5]*wy + e[9]*wz  + e[13];
        arr[bufStart + 2] = e[2]*wx + e[6]*wy + e[10]*wz + e[14];
      }
      _points.geometry.attributes.position.needsUpdate = true;
    }

    // Update close-star pool — assign nearest N glow stars to billboard slots
    if (_camera && _closePool.length > 0 && _glowStarData.length > 0) {
      const camPos = _camera.position;
      const nearby = _glowStarData
        .map(sd => ({ sd, d: camPos.distanceTo(sd.starMesh ? sd.starMesh.position : sd.pos) }))
        .filter(x => x.d < 5.0)
        .sort((a, b) => a.d - b.d)
        .slice(0, CLOSE_POOL_SIZE);

      for (let i = 0; i < CLOSE_POOL_SIZE; i++) {
        const slot = _closePool[i];
        if (i < nearby.length) {
          const { sd, d } = nearby[i];
          // Transform to camera/eye space on the CPU (float64 JS precision) so the
          // GPU receives a small value that is accurate in float32 — avoids trembling
          // for stars at large world-space distances such as S-cluster stars (~26996 ly).
          const wp = sd.starMesh ? sd.starMesh.position : sd.pos;
          slot.uniforms.uStarPos.value.copy(wp).applyMatrix4(_camera.matrixWorldInverse);
          slot.uniforms.uColor.value.copy(sd.color);
          slot.uniforms.uDist.value = d;
          slot.uniforms.uSize.value = 1.0;
          slot.uniforms.uBrightness.value = sd.brightness;
          slot.uniforms.uStarRadius.value = sd.starMesh ? sd.starMesh.scale.x : sd.starRadius;
          slot.uniforms.uDiskAmp.value    = sd.noCoreDisk ? 0.0 : 1.0;
        } else {
          slot.uniforms.uDist.value = 999.0;
        }
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function init({ scene, camera, controls, stars, visibilityConfig }) {
    _scene = scene;
    _camera = camera;
    _controls = controls || null;
    _visibilityConfig = visibilityConfig;
    build(stars);
    _buildCloseMesh();
  }

  function rebuild(stars) {
    if (_scene) build(stars);
  }

  function markDynamicDirty() { /* positions updated every frame — no-op */ }

  return { init, update, rebuild, markDynamicDirty };
})();

window.StarVisuals = StarVisuals;
window.StarVisualsConfig = StarVisualsConfig;
