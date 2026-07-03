import * as THREE from "three";

// ══════════════════════════════════════════════════════════════════════════════
//  PARAMETERS — edit these to tune the black hole appearance
// ══════════════════════════════════════════════════════════════════════════════
const BlackHoleConfig = {
  // ── Accretion disk geometry ──────────────────────────────────────────────────
  diskInnerMult: 1.08,   // inner disk radius  = EH_radius x this
  diskOuterMult: 4.80,   // outer disk radius  = EH_radius x this
  diskTiltDeg:   60.0,   // disk tilt in degrees

  // ── Disk vertical profile ────────────────────────────────────────────────────
  diskThickness: 0.50,   // base disk half-thickness (fraction of EH radius)
  diskFlare:     3.0,    // extra puffing near inner edge (multiplier)

  // ── Accretion disk brightness ────────────────────────────────────────────────
  diskBrightness: 2.0,   // overall emission multiplier
  innerGlowAmt:   1.0,   // brightness boost at inner edge (ISCO region)
  innerGlowFall:  3.0,   // falloff rate of inner glow

  // ── Relativistic Doppler beaming ─────────────────────────────────────────────
  orbitalBeta:     0.35, // orbital speed as fraction of c (0-1)
  beamingPower:    2.9,  // beaming exponent
  dopplerColorStr: 0.3,  // colour-shift strength

  // ── Turbulent noise / inhomogeneities ────────────────────────────────────────
  noiseScale:    18.0,
  noiseAmt:      0.7,
  noiseOctaves:  4,
  angularSpeed:  0.06,
  spiralPitch:   2.0,
  warpAmt:       0.8,
  warpScale:     0.4,
  clumpPower:    2.0,

  // ── Infalling matter (spherical component near event horizon) ─────────────────
  sphereBlendR:     2.5,   // radius (x EH) where infalling matter fades out
  sphereAmt:        1.2,   // density of infalling matter near EH  ← main density knob
  sphereIso:        0.85,  // how isotropic at EH (0 = equator only, 1 = full sphere)
  inflowNoiseScale: 4.0,   // spatial scale of infalling stream noise
  inflowSpeed:      0.12,  // speed at which streams appear to fall inward

  // ── Ray-march quality ────────────────────────────────────────────────────────
  marchSteps:    48,    // steps per ray (24 = fast, 80 = quality)

  // ── Photon sphere glow ───────────────────────────────────────────────────────
  glowRadiusMult:   1.06,
  photonBrightness: 2.0,
  photonSharpness:  20.0,
  coronaBrightness:  0.1,
};
// ══════════════════════════════════════════════════════════════════════════════

const BlackHole = (() => {
  let _group      = null;
  let _diskMat    = null;
  let _lastScene  = null;
  let _lastPos    = null;
  let _lastRadius = 0.1;

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
        float rim    = 1.0 - cosA;

        float photon = pow(rim, PHOTON_SHARPNESS) * PHOTON_BRIGHTNESS;
        float corona = pow(rim, 5.0) * CORONA_BRIGHTNESS;

        vec3  col   = mix(vec3(0.80, 0.50, 0.18), vec3(1.00, 0.96, 0.86), rim);
        float alpha = clamp(photon + corona, 0.0, 1.0);
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col * (photon * 5.0 + corona), alpha);
      }
    `;
  }

  // ── Volumetric disk vertex shader ─────────────────────────────────────────────
  const VOL_VERT = /* glsl */ `
    varying vec3 vLocalPos;
    void main() {
      vLocalPos   = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Builds a ray-marched volumetric shader combining:
  //  - accretion disk  (density field — no geometry edges, soft natural falloff)
  //  - isotropic infalling matter near the event horizon (spherical component)
  // Both share one continuous density/emission evaluation along each view ray.
  function buildDiskShader(cfg, R, DISK_INNER, DISK_OUTER) {
    const tilt    = (cfg.diskTiltDeg * Math.PI) / 180;
    const OUTER_R = DISK_OUTER * 1.6;
    const STEPS   = Math.max(24, Math.min(96, cfg.marchSteps | 0));
    const octaves = Math.max(1, Math.min(6, Math.round(cfg.noiseOctaves)));

    let fbmBody = '';
    for (let i = 0; i < octaves; i++) {
      fbmBody += `    sum += valueNoise(p * ${Math.pow(2, i).toFixed(2)}) * ${Math.pow(0.5, i).toFixed(6)};\n`;
    }
    const fbmNorm = (2.0 - Math.pow(0.5, octaves - 1)).toFixed(6);

    return /* glsl */ `
      precision highp float;
      varying vec3  vLocalPos;
      uniform vec3  uCamLocal;
      uniform float uTime;

      #define EH_R    ${R.toFixed(6)}
      #define INNER   ${DISK_INNER.toFixed(6)}
      #define OUTER   ${DISK_OUTER.toFixed(6)}
      #define OUTER_R ${OUTER_R.toFixed(6)}
      #define T_COS   ${Math.cos(tilt).toFixed(6)}
      #define T_SIN   ${Math.sin(tilt).toFixed(6)}
      #define THICK   ${cfg.diskThickness.toFixed(4)}
      #define FLARE   ${cfg.diskFlare.toFixed(4)}
      #define SPH_B    ${cfg.sphereBlendR.toFixed(4)}
      #define SPH_A    ${cfg.sphereAmt.toFixed(4)}
      #define SPH_ISO  ${cfg.sphereIso.toFixed(4)}
      #define SPH_NS   ${cfg.inflowNoiseScale.toFixed(4)}
      #define SPH_WSPD ${cfg.inflowSpeed.toFixed(6)}
      #define BRIGHT  ${cfg.diskBrightness.toFixed(4)}
      #define IGLOW   ${cfg.innerGlowAmt.toFixed(4)}
      #define IFALL   ${cfg.innerGlowFall.toFixed(4)}
      #define BETA    ${cfg.orbitalBeta.toFixed(4)}
      #define BEAM    ${cfg.beamingPower.toFixed(4)}
      #define DCOL    ${cfg.dopplerColorStr.toFixed(4)}
      #define NS      ${cfg.noiseScale.toFixed(4)}
      #define NAMT    ${cfg.noiseAmt.toFixed(4)}
      #define WSPD    ${cfg.angularSpeed.toFixed(6)}
      #define SPITCH  ${cfg.spiralPitch.toFixed(4)}
      #define WAMT    ${cfg.warpAmt.toFixed(4)}
      #define WSCL    ${cfg.warpScale.toFixed(4)}
      #define CLUMP   ${(1.0 / Math.max(0.1, cfg.clumpPower)).toFixed(6)}
      #define STEPS   ${STEPS}

      // Rotate point to disk-local space where the disk lies in the XZ plane.
      vec3 toDisk(vec3 p) {
        return vec3(p.x, p.y * T_COS + p.z * T_SIN, -p.y * T_SIN + p.z * T_COS);
      }

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float sum = 0.0;
${fbmBody}        return sum / ${fbmNorm};
      }

      void main() {
        vec3 ro = uCamLocal;
        vec3 rd = normalize(vLocalPos - uCamLocal);

        // Ray–sphere intersections for the outer bounding volume.
        float b  = dot(ro, rd);
        float c  = dot(ro, ro) - OUTER_R * OUTER_R;
        float dc = b*b - c;
        if (dc < 0.0) discard;
        float sq = sqrt(dc);
        float tS = max(0.0, -b - sq);
        float tF = -b + sq;
        if (tF < 0.0) discard;

        // Stop ray at event horizon.
        float ceh = dot(ro, ro) - EH_R * EH_R;
        float deh = b*b - ceh;
        float tEH = (deh >= 0.0) ? max(0.0, -b - sqrt(max(0.0, deh))) : tF;
        float tE  = min(tF, tEH);
        if (tE <= tS) discard;

        float dt  = (tE - tS) / float(STEPS);
        vec3  col = vec3(0.0);

        // Camera XZ direction in disk space — precomputed once for Doppler.
        vec3  camD = toDisk(uCamLocal);
        float cLen = length(camD.xz);
        vec2 camXZ = cLen > 0.001 ? camD.xz / cLen : vec2(1.0, 0.0);

        for (int i = 0; i < STEPS; i++) {
          float mt = tS + (float(i) + 0.5) * dt;
          vec3  mp = ro + rd * mt;
          float r  = length(mp);
          if (r < EH_R) break;

          vec3  dp = toDisk(mp);
          float rD = length(dp.xz);
          float h  = dp.y;

          // ── Disk density ────────────────────────────────────────────────────
          // Vertical profile: Gaussian, half-thickness puffs near inner edge.
          float th = EH_R * THICK + EH_R * FLARE * max(0.0, (INNER - rD) / INNER);
          float vd = exp(-(h / max(th, 1e-5)) * (h / max(th, 1e-5)));
          // Radial: smooth inner rise, exponential outer fade (no sharp cutoffs).
          float ri  = smoothstep(INNER * 0.8, INNER, rD);
          float ro2 = exp(-max(0.0, rD - OUTER * 0.75) / (OUTER * 0.35));
          float dDisk = vd * ri * ro2;

          // ── Infalling streams near EH ────────────────────────────────────────
          // Isotropy blend: equatorial at larger radii, configurable at EH surface.
          float sph      = 1.0 - smoothstep(EH_R, EH_R * SPH_B, r);
          float cosDisk  = length(dp.xz) / max(r, EH_R * 0.001);
          float eqW      = cosDisk * cosDisk;
          float veryNear = 1.0 - smoothstep(EH_R, EH_R * 1.5, r);
          float isoW     = mix(eqW, 1.0, SPH_ISO * veryNear);
          // 3D stream noise: angular direction + radial infall animation.
          // Two offset projections of the unit-sphere direction avoid seams.
          vec3  nd_sph   = mp / max(r, EH_R * 0.001);
          float rNorm    = r / (EH_R * SPH_B);
          float iT       = rNorm - uTime * SPH_WSPD;
          vec2  sUV1     = vec2(nd_sph.x * 0.7 + nd_sph.y * 0.5, nd_sph.z * 0.7 + nd_sph.y * 0.4) * SPH_NS;
          vec2  sUV2     = vec2(nd_sph.z * 0.8 + nd_sph.x * 0.3, nd_sph.y * 0.9 - nd_sph.z * 0.2) * SPH_NS * 1.37;
          float sn1      = fbm(sUV1 + vec2(iT, iT * 0.61));
          float sn2      = valueNoise(sUV2 + vec2(iT * 1.23, iT * 0.47));
          float stream   = pow(max(0.0, sn1 * 0.65 + sn2 * 0.35), 2.0);
          float dSph     = SPH_A * sph * isoW * (0.15 + 0.85 * stream);

          float d = dDisk + dSph;
          if (d < 0.001) continue;

          // ── Temperature gradient (disk) ─────────────────────────────────────
          float tFr = clamp((rD - INNER) / (OUTER - INNER), 0.0, 1.0);
          float ht  = 1.0 - tFr;
          vec3 e    = ht > 0.5
            ? mix(vec3(0.90, 0.46, 0.10), vec3(1.00, 0.93, 0.80), (ht - 0.5) * 2.0)
            : mix(vec3(0.52, 0.13, 0.02), vec3(0.90, 0.46, 0.10), ht * 2.0);

          // ── Turbulent spiral noise (disk) ───────────────────────────────────
          float ang   = atan(dp.z, dp.x);
          float logR  = log(max(rD / INNER, 0.001));
          float omega = pow(INNER / max(rD, INNER * 0.01), 1.5);
          float rotA  = ang + uTime * omega * WSPD;
          float spU   = rotA - logR * SPITCH;
          vec2  uv    = vec2(spU, logR) * NS;
          float wx = valueNoise(uv * WSCL) * 2.0 - 1.0;
          float wy = valueNoise(uv * WSCL + vec2(5.23, 1.71)) * 2.0 - 1.0;
          float n  = fbm(uv + vec2(wx, wy) * WAMT);
          float ndd = n - 0.5;
          float sc = 0.5 + sign(ndd) * pow(min(abs(ndd) * 2.0, 1.0), CLUMP) * 0.5;
          e *= 1.0 + (sc - 0.5) * 2.0 * NAMT;

          // ── Relativistic Doppler beaming (disk) ─────────────────────────────
          vec2  vel  = vec2(-sin(ang), cos(ang));
          float dopp = dot(vel, camXZ);
          float bm   = pow(clamp(1.0 + BETA * dopp, 0.05, 6.0), BEAM);
          e.b *= 1.0 + dopp * DCOL;
          e.r *= 1.0 - dopp * DCOL * 0.6;
          e   *= bm;

          // ── ISCO inner glow ─────────────────────────────────────────────────
          e *= 1.0 + exp(-tFr * IFALL) * IGLOW;

          // ── Blend in stream emission for the spherical infalling component ──
          // Hot orange-white: matter heating up as it spirals in from all directions.
          vec3  eStream = vec3(1.0, 0.72, 0.30);
          float sphFrac = dSph / max(d, 0.001);
          e = mix(e, eStream, clamp(sphFrac * 1.2, 0.0, 0.85));

          col += e * d * dt;
        }

        if (col.r + col.g + col.b < 0.004) discard;
        gl_FragColor = vec4(col * BRIGHT, 1.0);
      }
    `;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function create(scene, position, radius) {
    _lastScene  = scene;
    _lastPos    = position.clone();
    _lastRadius = radius;
    _group    = new THREE.Group();
    _group.position.copy(position);

    const cfg        = BlackHoleConfig;
    const R          = radius;
    const DISK_INNER = R * cfg.diskInnerMult;
    const DISK_OUTER = R * cfg.diskOuterMult;
    const GLOW_R     = R * cfg.glowRadiusMult;

    // 1. Event horizon — opaque black sphere.
    const ehMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    ehMesh.renderOrder = 1;
    ehMesh.shine       = true;
    _group.add(ehMesh);

    // 2. Photon-sphere glow — rim-brightening additive sphere.
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

    // 3. Volumetric accretion disk + infalling matter sphere.
    //    A single large sphere mesh is ray-marched in the fragment shader.
    //    Disk tilt and all structure are computed analytically — no geometry puffing,
    //    no explicit edges; density falls off naturally at inner/outer boundaries.
    _diskMat = new THREE.ShaderMaterial({
      vertexShader:   VOL_VERT,
      fragmentShader: buildDiskShader(cfg, R, DISK_INNER, DISK_OUTER),
      uniforms: {
        uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
        uTime:     { value: 0 },
      },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.FrontSide,
    });
    const volMesh = new THREE.Mesh(
      new THREE.SphereGeometry(DISK_OUTER * 1.6, 64, 64),
      _diskMat
    );
    volMesh.renderOrder = 3;
    volMesh.shine       = true;
    _group.add(volMesh);

    return _group;
  }

  function rebuild() {
    if (!_lastScene || !_lastPos) return;
    if (_group) {
      _lastScene.remove(_group);
      _group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      _group   = null;
      _diskMat = null;
    }
    const g = create(_lastScene, _lastPos, _lastRadius);
    _lastScene.add(g);
  }

  // Call once per frame — updates camera position and animation time.
  function update(camera) {
    if (!_diskMat || !_group) return;
    _diskMat.uniforms.uTime.value = performance.now() / 1000.0;
    // Pass raw camera-relative position; disk tilt is handled inside the shader.
    _diskMat.uniforms.uCamLocal.value.copy(
      camera.position.clone().sub(_group.position)
    );
  }

  return { create, update, rebuild };
})();

// Expose to browser console for live inspection (reload page to apply changes).
window.BlackHole       = BlackHole;
window.BlackHoleConfig = BlackHoleConfig;

export { BlackHole, BlackHoleConfig };
