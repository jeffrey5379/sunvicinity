import * as THREE from "three";
import { xyzToRaDec, formatRaHMS, formatDecDMS } from "./utils.js";

export const Minimap = (() => {
  const FOV = 48;        // smaller = more zoomed in
  const LABEL_R = 12;    // sphere radius the name labels are projected from
  const DOT_R = 8;       // radius the controls.target dot is drawn at
  const DOT_SIZE = 0.12; // controls.target dot sphere radius
  const COORDS_GAP = 6;  // px between the ra/dec line and the minimap frame

  let container, coordsEl, renderer, scene, cam, dot, lineMat;
  let lines = [], labels = [], ready = false;
  const _v = new THREE.Vector3();

  function init(el, coordsElArg) {
    container = el;
    coordsEl = coordsElArg || null;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100000.0);
    // Frame, constellation lines and labels all share --minimap-color from CSS.
    const color = new THREE.Color(
      getComputedStyle(document.documentElement).getPropertyValue("--minimap-color").trim() || "#808080"
    );
    lineMat = new THREE.LineBasicMaterial({ color: color });
    dot = new THREE.Mesh(
      new THREE.SphereGeometry(DOT_SIZE, 12, 12),
      new THREE.MeshBasicMaterial({ color: color })
    );
    scene.add(dot);
    resize();
  }

  function resize() {
    const w = container.clientWidth || 260, h = container.clientHeight || 200;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  function dispose() {
    for (const line of lines) {
      scene.remove(line);
      line.geometry.dispose();
    }
    for (const label of labels) label.el.remove();
    lines = [];
    labels = [];
    ready = false;
  }

  // Rebuilt whenever the scene is (re)loaded — constellation star positions are
  // only final once the catalog has been processed. labelData: [{name, theta, phi}].
  function build(constellationLines, labelData) {
    dispose();
    for (const points of constellationLines) {
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geom, lineMat);
      line.frustumCulled = false; // some constellation stars lack a position -> NaN bounds
      lines.push(line);
      scene.add(line);
    }
    // Constellation names are plain HTML overlays (same font as #info),
    // positioned each frame by projecting their sky point.
    for (const d of labelData) {
      const el = document.createElement("div");
      el.className = "minimap-label";
      el.textContent = d.name;
      container.appendChild(el);
      labels.push({ el: el, pos: new THREE.Vector3().setFromSphericalCoords(LABEL_R, d.theta, d.phi) });
    }
    ready = true;
  }

  function render(camera, controls, visible) {
    if (!ready || !visible) {
      if (container.style.display !== "none") container.style.display = "none";
      if (coordsEl && coordsEl.style.display !== "none") coordsEl.style.display = "none";
      return;
    }
    if (container.style.display !== "block") {
      container.style.display = "block";
      resize();
    }
    cam.position.set(0, 0, 0);
    cam.up.copy(camera.up);
    cam.lookAt(controls.target);
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    dot.position.copy(controls.target).setLength(DOT_R);
    renderer.render(scene, cam);
    const w = container.clientWidth, h = container.clientHeight;
    for (const label of labels) {
      _v.copy(label.pos).project(cam);
      if (_v.z > 1 || _v.x < -1 || _v.x > 1 || _v.y < -1 || _v.y > 1) {
        label.el.style.display = "none";
      } else {
        label.el.style.display = "";
        label.el.style.left = (_v.x * 0.5 + 0.5) * w + "px";
        label.el.style.top = (-_v.y * 0.5 + 0.5) * h + "px";
      }
    }

    if (coordsEl) {
      const t = controls.target;
      const { raDegrees, decDegrees } = xyzToRaDec(t.x, t.y, t.z);
      coordsEl.textContent = "ra: " + formatRaHMS(raDegrees) + "  dec: " + formatDecDMS(decDegrees);
      coordsEl.style.display = "block";
      // Positioned from the minimap frame's own live rect (not a hardcoded
      // offset) so it tracks the frame's left edge whatever size it's given.
      const rect = container.getBoundingClientRect();
      coordsEl.style.left = rect.left + "px";
      coordsEl.style.top = (rect.top - COORDS_GAP - coordsEl.offsetHeight) + "px";
    }
  }

  return { init, build, render, resize, dispose };
})();
