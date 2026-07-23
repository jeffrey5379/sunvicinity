import * as THREE from "three";

// Colour for B-type stars (matches stars_classes.txt entry for B)
const B_STAR_COLOR = 0x9090fa;

// ly per arcsecond at Sgr A* — derived from the app's R0 = 26996 ly
const LY_PER_ARCSEC = 26996 * (Math.PI / 648000); // R0 * (pi / (180*3600))

// Uniform scale factor applied to all orbital radii. Increase to spread orbits
// outward from the black hole without changing their shape or relative sizes.
export const ORBIT_SCALE = 200.0;

export const SCluster = (() => {
  let _stars      = [];   // { mesh, el }
  const _orbitLines = [];
  let _orbitMat   = null;
  let _bhPos    = null;
  let _eastVec  = null;
  let _northVec = null;
  let _bhDir    = null;

  // ── Kepler equation solver (Newton-Raphson) ──────────────────────────────────
  function _solveKepler(M, e) {
    let E = M;
    for (let k = 0; k < 64; k++) {
      const dE = (M - E + e * Math.sin(E)) / (1.0 - e * Math.cos(E));
      E += dE;
      if (Math.abs(dE) < 1e-11) break;
    }
    return E;
  }

  // ── Orbital position in sky-plane coordinates ────────────────────────────────
  // Returns { east, north, zlos } in arcseconds.
  // Convention: East = +RA*cos(Dec), North = +Dec, zlos = toward observer.
  // Orbital elements follow Campbell/Gillessen+2017 convention:
  //   Omega = pos. angle of ascending node, measured North->East in sky plane.
  function _orbitPos(el, t) {
    const DEG = Math.PI / 180;
    const { a, e, i, Omega, omega, T0, P } = el;
    const iR = i * DEG, OR = Omega * DEG, oR = omega * DEG;

    // Mean anomaly (handle large t via modulo)
    let M = (((t - T0) / P) % 1.0) * 2 * Math.PI;
    if (M < 0) M += 2 * Math.PI;

    const E = _solveKepler(M, e);

    // Orbital-plane position in arcsec
    const xOrb = a * (Math.cos(E) - e);
    const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E);

    // Thiele-Innes rotation to (East, North, Z-toward-observer)
    const cosO = Math.cos(OR), sinO = Math.sin(OR);
    const coso = Math.cos(oR), sino = Math.sin(oR);
    const cosi = Math.cos(iR), sini = Math.sin(iR);

    const east  = ( coso * sinO + sino * cosi * cosO) * xOrb
                + (-sino * sinO + coso * cosi * cosO) * yOrb;
    const north = ( coso * cosO - sino * cosi * sinO) * xOrb
                + (-sino * cosO - coso * cosi * sinO) * yOrb;
    const zlos  = ( sino * sini) * xOrb
                + ( coso * sini) * yOrb;

    return { east, north, zlos };
  }

  // ── Set mesh world position from sky offsets ─────────────────────────────────
  function _applyPos(mesh, east, north, zlos) {
    const scale = LY_PER_ARCSEC * ORBIT_SCALE;
    mesh.position
      .copy(_bhPos)
      .addScaledVector(_eastVec,  east  * scale)
      .addScaledVector(_northVec, north * scale)
      .addScaledVector(_bhDir,   -zlos  * scale);
  }

  // ── Public: parse s_cluster_data.txt ────────────────────────────────────────
  function parse(text) {
    const elements = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const p = t.split("|");
      if (p.length < 9) continue;
      elements.push({
        name:         p[0].trim(),
        spectralType: p[1].trim(),
        a:     parseFloat(p[2]),
        e:     parseFloat(p[3]),
        i:     parseFloat(p[4]),
        Omega: parseFloat(p[5]),
        omega: parseFloat(p[6]),
        T0:    parseFloat(p[7]),
        P:     parseFloat(p[8]),
      });
    }
    return elements;
  }

  // ── Public: create meshes and add to scene ──────────────────────────────────
  // starGeometry and DEFAULT_RADIUS must match the main app so visuals.js treats
  // these stars identically to the regular ones.
  function init(scene, bhMesh, elements, { starGeometry, DEFAULT_RADIUS, APPTYPE }) {
    _bhPos = bhMesh.position.clone();

    const worldUp = new THREE.Vector3(0, 1, 0);
    _bhDir    = _bhPos.clone().normalize();
    _eastVec  = new THREE.Vector3().crossVectors(worldUp, _bhDir).normalize();
    _northVec = new THREE.Vector3().crossVectors(_bhDir, _eastVec).normalize();

    for (const el of elements) {
      const mat  = new THREE.MeshBasicMaterial({ color: B_STAR_COLOR });
      const mesh = new THREE.Mesh(starGeometry, mat);

      // Mirror every property that createStar() sets so adjustStars() and
      // StarVisuals work identically for S-cluster stars.
      mesh.scale.setScalar(DEFAULT_RADIUS);
      mesh.initialscale  = DEFAULT_RADIUS;
      mesh.apptype       = APPTYPE.STAR;
      mesh.dynamicPosition = true;
      mesh.name          = el.name;
      mesh.spectralClass = el.spectralType.charAt(0); // 'B'
      mesh.spectralType  = el.spectralType;
      mesh.text          = `Class ${el.spectralType}. Period ${el.P.toFixed(1)} years.`;

      const { east, north, zlos } = _orbitPos(el, new Date().getFullYear());
      _applyPos(mesh, east, north, zlos);

      scene.add(mesh);
      _stars.push({ mesh, el });
    }
  }

  // ── Public: advance all S-star positions to year t ──────────────────────────
  function update(t) {
    for (const { mesh, el } of _stars) {
      const { east, north, zlos } = _orbitPos(el, t);
      _applyPos(mesh, east, north, zlos);
    }
  }

  // ── Public: return the Three.js meshes (to push into spheres[]) ─────────────
  function getMeshes() {
    return _stars.map(s => s.mesh);
  }

  // ── Public: draw orbit ellipses for all S-stars ─────────────────────────────
  function initOrbits(scene, color) {
    for (const line of _orbitLines) {
      scene.remove(line);
      line.geometry.dispose();
    }
    if (_orbitMat) _orbitMat.dispose();
    _orbitLines.length = 0;

    _orbitMat = new THREE.LineBasicMaterial({ color });
    const scale = LY_PER_ARCSEC * ORBIT_SCALE;
    const DEG = Math.PI / 180;
    const N = 128;

    for (const { el } of _stars) {
      const { a, e, i, Omega, omega } = el;
      const iR = i * DEG, OR = Omega * DEG, oR = omega * DEG;
      const cosO = Math.cos(OR), sinO = Math.sin(OR);
      const coso = Math.cos(oR), sino = Math.sin(oR);
      const cosi = Math.cos(iR), sini = Math.sin(iR);
      const bSemi = a * Math.sqrt(1 - e * e);

      const pts = [];
      for (let k = 0; k <= N; k++) {
        const E = (k / N) * 2 * Math.PI;
        const xOrb = a * (Math.cos(E) - e);
        const yOrb = bSemi * Math.sin(E);
        const east  = ( coso * sinO + sino * cosi * cosO) * xOrb
                    + (-sino * sinO + coso * cosi * cosO) * yOrb;
        const north = ( coso * cosO - sino * cosi * sinO) * xOrb
                    + (-sino * cosO - coso * cosi * sinO) * yOrb;
        const zlos  = ( sino * sini) * xOrb
                    + ( coso * sini) * yOrb;
        pts.push(new THREE.Vector3()
          .addScaledVector(_eastVec,  east  * scale)
          .addScaledVector(_northVec, north * scale)
          .addScaledVector(_bhDir,   -zlos  * scale));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), _orbitMat);
      line.position.copy(_bhPos);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      _orbitLines.push(line);
    }
  }

  // ── Public: show or hide all orbit lines ─────────────────────────────────────
  function setOrbitsVisible(visible) {
    for (const line of _orbitLines) line.visible = visible;
  }

  // ── Public: remove from scene and free GPU memory ───────────────────────────
  function dispose(scene) {
    for (const { mesh } of _stars) {
      scene.remove(mesh);
      mesh.material.dispose();
    }
    _stars = [];
    for (const line of _orbitLines) {
      scene.remove(line);
      line.geometry.dispose();
    }
    if (_orbitMat) { _orbitMat.dispose(); _orbitMat = null; }
    _orbitLines.length = 0;
  }

  return { parse, init, update, getMeshes, dispose, initOrbits, setOrbitsVisible };
})();
