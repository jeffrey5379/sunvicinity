import * as THREE from "three";

// ══════════════════════════════════════════════════════════════════════════════
//  PARAMETERS — edit these to tune the black hole appearance
// ══════════════════════════════════════════════════════════════════════════════
const BlackHoleConfig = {
  // ── Accretion disk geometry ──────────────────────────────────────────────────
  diskInnerMult: 1.08,   // inner disk radius  = EH_radius x this
  diskOuterMult: 4.80,   // outer disk radius  = EH_radius x this
  diskTiltDeg:   60.0,   // degrees from edge-on (0 = fully edge-on, 90 = face-on)

  // ── Disk vertical profile (puffing) ─────────────────────────────────────────
  diskPuffHeight: 0.8,  // max half-thickness at inner edge (fraction of EH radius)
  diskPuffPower:  3.0,   // how fast disk thins outward (1 = linear, 2 = quadratic)

  // ── Accretion disk brightness ────────────────────────────────────────────────
  diskBrightness: 0.05,  // overall emission multiplier (0 = off, 2 = twice as bright)
  innerGlowAmt:   0.0,   // brightness boost right at the inner edge (ISCO region)
  innerGlowFall:  3.0,   // exponential falloff rate of the inner-edge boost

  // ── Relativistic Doppler beaming ─────────────────────────────────────────────
  orbitalBeta:     0.35, // orbital speed as fraction of c (0-1); controls intensity asymmetry
  beamingPower:    2.9,  // exponent n in (1 + beta*cos_theta)^n
  dopplerColorStr: 0.3, // colour-shift strength (0 = no hue change, 0.5 = strong)

  // ── Turbulent noise / inhomogeneities ────────────────────────────────────────
  noiseScale:    18.0,   // spatial frequency — lower = bigger blobs, higher = finer detail
  noiseAmt:      0.7,   // brightness variation amplitude (0 = uniform, 1 = full range)
  noiseOctaves:  4,     // FBM octave count, clamped internally to 1-6
  angularSpeed:  0.06,   // orbital speed multiplier — noise rotates with Keplerian shear
  spiralPitch:   2.0,   // logarithmic spiral arm tightness (0 = rings, 4 = tight spirals)
  warpAmt:       0.8,   // domain warp strength — breaks spiral regularity (0 = none, 2 = chaotic)
  warpScale:     0.4,   // spatial scale of warp noise relative to NOISE_SCALE
  clumpPower:    2.0,   // clumping contrast: 1 = linear, 3 = hard bright clumps / dark voids

  // ── Edge fading ──────────────────────────────────────────────────────────────
  diskFadeInner: 0.14,   // inner fade zone (fraction of disk radial span, 0 = sharp)
  diskFadeOuter: 0.22,   // outer fade zone (fraction of disk radial span, 0 = sharp)

  // ── Photon sphere glow ───────────────────────────────────────────────────────
  glowRadiusMult:   1.06, // glow sphere radius = EH_radius x this
  photonBrightness: 2.0, // peak brightness of the photon ring
  photonSharpness:  20.0, // pow exponent — higher = thinner, sharper ring
  coronaBrightness:  0.1, // diffuse outer corona brightness
};
// ══════════════════════════════════════════════════════════════════════════════

const BlackHole = (() => {
  let _group    = null;
  let _diskMat  = null;
  let _diskTilt = 0;

  // ── Glow sphere vertex shader (no config dependence) ─────────────────────────
  const GLOW_VERT = /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
      vNormal     = normalize(normalMatrix * normal);
      vec4 mv     = modelViewMatrix * vec4(position, 1.0);
      vViewDir    = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `;

  // ── Fragment/vertex shader builders — inject config as #define constants ──────
  // Mirroring the pattern used in star-visuals.js buildFragShader().

  function buildGlowShader(cfg) {
    return /* glsl */ `
      precision highp float;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      #define PHOTON_BRIGHTNESS ${cfg.photonBrightness.toFixed(4)}
      #define PHOTON_SHARPNESS  ${cfg.photonSharpness.toFixed(4)}
      #define CORONA_BRIGHTNESS ${cfg.coronaBrightness.toFixed(4)}

      void main() {
        float cosA   = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float rim    = 1.0 - cosA;   // 0 at face-on center, 1 at limb

        float photon = pow(rim, PHOTON_SHARPNESS) * PHOTON_BRIGHTNESS;
        float corona = pow(rim, 5.0) * CORONA_BRIGHTNESS;

        vec3  col   = mix(vec3(0.80, 0.50, 0.18), vec3(1.00, 0.96, 0.86), rim);
        float alpha = clamp(photon + corona, 0.0, 1.0);
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col * (photon * 5.0 + corona), alpha);
      }
    `;
  }

  // Disk vertex shader — simple pass-through.
  // Puffing (Z displacement) is baked into the BufferGeometry by
  // buildPuffedDiskGeometry(), so this shader needs no config injection.
  const DISK_VERT = /* glsl */ `
    varying vec3 vLocalPos;
    void main() {
      vLocalPos   = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  function buildDiskFragShader(cfg, innerR, outerR) {
    // Unroll the FBM loop at template time for full GLSL ES 1.0 compatibility.
    // (Loop bounds must be compile-time constants in ES 1.0.)
    const octaves = Math.max(1, Math.min(6, Math.round(cfg.noiseOctaves)));
    let fbmBody = '';
    for (let i = 0; i < octaves; i++) {
      const freq = Math.pow(2.0, i).toFixed(2);
      const amp  = Math.pow(0.5, i).toFixed(6);
      fbmBody += `        sum += valueNoise(p * ${freq}) * ${amp};\n`;
    }
    // Geometric series normalisation: sum of amps = 2 - 0.5^(octaves-1)
    const fbmNorm = (2.0 - Math.pow(0.5, octaves - 1)).toFixed(6);

    return /* glsl */ `
      precision highp float;
      varying vec3  vLocalPos;
      // Camera position in disk-local space — updated every frame via uniform.
      uniform vec3  uCamLocal;

      #define INNER_R          ${innerR.toFixed(6)}
      #define OUTER_R          ${outerR.toFixed(6)}
      #define DISK_BRIGHTNESS  ${cfg.diskBrightness.toFixed(6)}
      #define INNER_GLOW_AMT   ${cfg.innerGlowAmt.toFixed(4)}
      #define INNER_GLOW_FALL  ${cfg.innerGlowFall.toFixed(4)}
      #define ORBITAL_BETA     ${cfg.orbitalBeta.toFixed(4)}
      #define BEAMING_POW      ${cfg.beamingPower.toFixed(4)}
      #define DOPPLER_COLOR    ${cfg.dopplerColorStr.toFixed(4)}
      #define NOISE_SCALE      ${cfg.noiseScale.toFixed(4)}
      #define NOISE_AMT        ${cfg.noiseAmt.toFixed(4)}
      #define ANGULAR_SPEED    ${cfg.angularSpeed.toFixed(6)}
      #define SPIRAL_PITCH     ${cfg.spiralPitch.toFixed(4)}
      #define WARP_AMT         ${cfg.warpAmt.toFixed(4)}
      #define WARP_SCALE       ${cfg.warpScale.toFixed(4)}
      #define CLUMP_CURVE      ${(1.0 / Math.max(0.1, cfg.clumpPower)).toFixed(6)}
      #define DISK_FADE_INNER  ${cfg.diskFadeInner.toFixed(4)}
      #define DISK_FADE_OUTER  ${cfg.diskFadeOuter.toFixed(4)}

      uniform float uTime;

      // ── Procedural value noise ────────────────────────────────────────────────
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);          // cubic smoothstep
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      // FBM (Fractal Brownian Motion) — loop unrolled for GLSL ES 1.0
      float fbm(vec2 p) {
        float sum = 0.0;
${fbmBody}        return sum / ${fbmNorm};
      }

      void main() {
        float r     = length(vLocalPos.xy);
        float angle = atan(vLocalPos.y, vLocalPos.x);

        // Normalised radial position: 0 = inner edge, 1 = outer edge
        float t = (r - INNER_R) / (OUTER_R - INNER_R);
        if (t < 0.0 || t > 1.0) discard;

        // ── Temperature gradient ──────────────────────────────────────────────
        // Inner edge: nearly white-hot.  Outer rim: cool deep red.
        float heat  = 1.0 - smoothstep(0.0, 0.60, t);
        vec3 hInner = vec3(1.00, 0.93, 0.80);   // white-yellow (hottest)
        vec3 hMid   = vec3(0.90, 0.46, 0.10);   // orange
        vec3 hOuter = vec3(0.52, 0.13, 0.02);   // deep red     (coolest)
        vec3 base   = heat > 0.5
                      ? mix(hMid,   hInner, (heat - 0.5) * 2.0)
                      : mix(hOuter, hMid,   heat * 2.0);

        // ── Spiral noise with Keplerian rotation and domain warping ──────────
        // spiralU is constant along logarithmic spiral arms (r = e^(theta/pitch)),
        // so sampling noise in (spiralU, logR) space concentrates structure along arms.
        // Domain warping then distorts those arms into irregular filaments and clumps.
        float logR     = log(r / INNER_R + 0.01);
        float omega    = pow(INNER_R / r, 1.5);             // Keplerian angular velocity
        float rotAngle = angle + uTime * omega * ANGULAR_SPEED;
        float spiralU  = rotAngle - logR * SPIRAL_PITCH;    // coordinate along spiral arms
        vec2 baseUV    = vec2(spiralU, logR) * NOISE_SCALE;
        // Two offset noise samples warp the sampling coordinates, breaking
        // the regular spiral bands into irregular clumps and dark voids.
        float wx = valueNoise(baseUV * WARP_SCALE) * 2.0 - 1.0;
        float wy = valueNoise(baseUV * WARP_SCALE + vec2(5.23, 1.71)) * 2.0 - 1.0;
        float noise    = fbm(baseUV + vec2(wx, wy) * WARP_AMT);
        // Contrast S-curve: CLUMP_CURVE < 1 → convex → pushes values away from 0.5.
        // clumpPower=1 → linear (no effect), clumpPower=3 → strong bright/dark separation.
        float d  = noise - 0.5;
        float sc = 0.5 + sign(d) * pow(min(abs(d) * 2.0, 1.0), CLUMP_CURVE) * 0.5;
        base *= 1.0 + (sc - 0.5) * 2.0 * NOISE_AMT;

        // ── Relativistic Doppler / aberration beaming ─────────────────────────
        // Prograde orbital tangent in disk-local XY at current azimuth angle
        vec2 vel      = vec2(-sin(angle), cos(angle));
        vec2 camXY    = uCamLocal.xy;
        float camLen  = length(camXY);
        vec2 camDir   = camLen > 0.001 ? camXY / camLen : vec2(1.0, 0.0);
        // doppler in [-1, +1]: +1 = approaching (blue-shift), -1 = receding (red-shift)
        float doppler = dot(vel, camDir);
        // Relativistic beaming intensity: I proportional to (1 + beta*cos_theta)^n
        float beam    = pow(1.0 + ORBITAL_BETA * doppler, BEAMING_POW);
        beam          = clamp(beam, 0.04, 6.0);

        // Colour shift controlled independently from intensity beaming
        base.b *= (1.0 + doppler * DOPPLER_COLOR);
        base.r *= (1.0 - doppler * DOPPLER_COLOR * 0.6);
        base   *= beam * DISK_BRIGHTNESS;

        // ── Inner-edge brightening (hot plasma near ISCO) ─────────────────────
        float innerGlow = exp(-t * INNER_GLOW_FALL) * INNER_GLOW_AMT;
        base *= (1.0 + innerGlow);

        // ── Edge fading — apply to both color and opacity ─────────────────────
        float edgeFade = smoothstep(0.0, DISK_FADE_INNER, t)
                       * (1.0 - smoothstep(1.0 - DISK_FADE_OUTER, 1.0, t));
        base          *= edgeFade;
        float opacity  = clamp(edgeFade, 0.0, 1.0);
        if (opacity < 0.005) discard;
        gl_FragColor  = vec4(base, opacity);
      }
    `;
  }

  // ── Geometry builder ──────────────────────────────────────────────────────────
  //
  // Creates a symmetric puffed disk with two physically separate surfaces:
  //   top    (z = +h(r), CCW winding → normals toward +Z)
  //   bottom (z = -h(r), CW winding  → normals toward -Z)
  //
  // Using FrontSide on this geometry renders both surfaces correctly from their
  // respective sides, avoiding the "cymbal" artifact that appears when a single
  // flat ring is displaced with DoubleSide.
  //
  // vLocalPos.xy in the fragment shader still equals the undisplaced polar XY,
  // so radius/angle calculations remain correct for both surfaces.
  //
  function buildPuffedDiskGeometry(innerR, outerR, angularSegs, radialSegs, puffH, puffPower) {
    const positions  = [];
    const indices    = [];

    const vertsPerRing = angularSegs + 1;
    const totalRings   = radialSegs + 1;
    const topOffset    = 0;
    const botOffset    = totalRings * vertsPerRing;

    for (let surface = 0; surface < 2; surface++) {
      const zSign = surface === 0 ? 1.0 : -1.0;

      for (let ri = 0; ri < totalRings; ri++) {
        const t = ri / radialSegs;
        const r = innerR + t * (outerR - innerR);
        const h = puffH * Math.pow(1.0 - t, puffPower);

        for (let ai = 0; ai < vertsPerRing; ai++) {
          const angle = (ai / angularSegs) * Math.PI * 2;
          positions.push(Math.cos(angle) * r, Math.sin(angle) * r, zSign * h);
        }
      }
    }

    for (let ri = 0; ri < radialSegs; ri++) {
      for (let ai = 0; ai < angularSegs; ai++) {
        // Top surface — CCW winding → normal toward +Z
        const t0 = topOffset + ri       * vertsPerRing + ai;
        const t1 = topOffset + ri       * vertsPerRing + (ai + 1);
        const t2 = topOffset + (ri + 1) * vertsPerRing + ai;
        const t3 = topOffset + (ri + 1) * vertsPerRing + (ai + 1);
        indices.push(t0, t2, t1,  t1, t2, t3);

        // Bottom surface — CW winding → normal toward -Z (visible from below)
        const b0 = botOffset + ri       * vertsPerRing + ai;
        const b1 = botOffset + ri       * vertsPerRing + (ai + 1);
        const b2 = botOffset + (ri + 1) * vertsPerRing + ai;
        const b3 = botOffset + (ri + 1) * vertsPerRing + (ai + 1);
        indices.push(b0, b1, b2,  b1, b3, b2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  // radius = event-horizon radius in scene units (ly).
  // Returns the THREE.Group; caller must scene.add() it.
  function create(scene, position, radius) {
    _group    = new THREE.Group();
    _group.position.copy(position);

    const cfg        = BlackHoleConfig;
    _diskTilt        = (cfg.diskTiltDeg * Math.PI) / 180;
    const R          = radius;
    const DISK_INNER = R * cfg.diskInnerMult;
    const DISK_OUTER = R * cfg.diskOuterMult;
    const GLOW_R     = R * cfg.glowRadiusMult;
    const puffH      = cfg.diskPuffHeight * R;

    // 1. Event horizon — opaque black sphere.
    //    Rendered first (renderOrder 1) so it populates the depth buffer and
    //    correctly occludes the disk and glow where they pass through the BH.
    const ehMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    ehMesh.renderOrder = 1;
    ehMesh.shine       = true;
    _group.add(ehMesh);

    // 2. Photon-sphere glow — rim-brightening sphere, additive blending.
    //    Depth-tested against the event horizon sphere.
    const glowMesh = new THREE.Mesh(
      new THREE.SphereGeometry(GLOW_R, 64, 32),
      new THREE.ShaderMaterial({
        vertexShader:   GLOW_VERT,
        fragmentShader: buildGlowShader(cfg),
        transparent:    true,
        depthWrite:     false,
        blending:       THREE.AdditiveBlending,
        side:           THREE.FrontSide,
      })
    );
    glowMesh.renderOrder = 2;
    glowMesh.shine       = true;
    _group.add(glowMesh);

    // 3. Accretion disk — double-surfaced puffed geometry, tilted in 3D.
    //    buildPuffedDiskGeometry() creates separate top (z=+h) and bottom (z=-h)
    //    surfaces with correctly oriented normals, so FrontSide renders both
    //    sides properly without the "cymbal" artifact of DoubleSide on a flat ring.
    _diskMat = new THREE.ShaderMaterial({
      vertexShader:   DISK_VERT,
      fragmentShader: buildDiskFragShader(cfg, DISK_INNER, DISK_OUTER),
      uniforms: {
        uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
        uTime:     { value: 0 },
      },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.FrontSide,
    });
    const diskMesh = new THREE.Mesh(
      buildPuffedDiskGeometry(DISK_INNER, DISK_OUTER, 200, 64, puffH, cfg.diskPuffPower),
      _diskMat
    );
    diskMesh.rotation.x  = _diskTilt;
    diskMesh.renderOrder = 3;
    diskMesh.shine       = true;
    _group.add(diskMesh);

    return _group;
  }

  // Call once per frame — updates Doppler direction and disk rotation time.
  function update(camera) {
    if (!_diskMat || !_group) return;
    _diskMat.uniforms.uTime.value = performance.now() / 1000.0;
    const camRel = camera.position.clone().sub(_group.position);
    const invRot = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-_diskTilt, 0, 0)
    );
    camRel.applyQuaternion(invRot);
    _diskMat.uniforms.uCamLocal.value.copy(camRel);
  }

  return { create, update };
})();

// Expose to browser console for live inspection (reload page to apply changes).
window.BlackHole       = BlackHole;
window.BlackHoleConfig = BlackHoleConfig;

export { BlackHole, BlackHoleConfig };
