import * as THREE from "three";
import { plxToLy, degreesToRad } from "./utils.js";

// Compact structure-of-arrays catalog for the full star dataset (millions of
// records). Only x/y/z positions are kept permanently, as typed arrays —
// name/spectral-type/size are recovered on demand by slicing the raw text
// lines, which are kept once (never duplicated per star, never copied into
// per-star strings). This is what makes holding the *entire* catalog in
// memory cheap enough to do unconditionally, so a search/agent jump anywhere
// in the dataset never needs to re-fetch or re-scan the source files.
export class StarCatalog {
  constructor() {
    this.count = 0;
    this.positions = new Float32Array(0);
    this._fileIndex = new Uint8Array(0);
    this._byteOffset = new Uint32Array(0);
    this._fileTexts = [];
    // S-cluster / other mesh-backed entries: { name, data, position, mesh }.
    // These are few (dozens), so keeping them as plain objects is fine.
    this._dynamic = [];
  }

  // Parses every "name|type|ra dec|plx|spectral|size" line across all given
  // raw file texts and indexes it. onCandidate(line, position, fileIdx, index),
  // if given, is invoked for every parsed record — index is its final index
  // into this catalog (stable, usable as a Map key) — so the caller can
  // decide whether to materialize a visible star for it right away.
  build(texts, onCandidate) {
    const positionsArr = [];
    const fileIndexArr = [];
    const byteOffsetArr = [];
    const scratch = new THREE.Vector3();

    for (let f = 0; f < texts.length; f++) {
      const text = texts[f];
      let start = 0;
      const len = text.length;
      while (start < len) {
        let end = text.indexOf("\n", start);
        if (end === -1) end = len;
        if (end > start) {
          const line = text.substring(start, end);
          if (this._parsePosition(line, scratch)) {
            const index = fileIndexArr.length;
            fileIndexArr.push(f);
            byteOffsetArr.push(start);
            positionsArr.push(scratch.x, scratch.y, scratch.z);
            if (onCandidate) onCandidate(line, scratch, f, index);
          }
        }
        start = end + 1;
      }
    }

    this.count = fileIndexArr.length;
    this.positions = Float32Array.from(positionsArr);
    this._fileIndex = Uint8Array.from(fileIndexArr);
    this._byteOffset = Uint32Array.from(byteOffsetArr);
    this._fileTexts = texts;
  }

  _parsePosition(line, target) {
    const params = line.split("|");
    if (params.length < 4 || !params[2]) return false;
    const coord = params[2].split(" ");
    if (coord.length < 2) return false;
    const ly = plxToLy(params[3]);
    const fi = degreesToRad(coord[0]);
    const theta = degreesToRad(coord[1]);
    target.setFromSphericalCoords(ly, Math.PI / 2 - theta, fi);
    return true;
  }

  // Recovers the original raw line for record i — the only place the full
  // text is ever reconstituted, and only for the handful of records that
  // are actually looked up (a star becoming visible, a search hit, ...).
  getRawLine(i) {
    const text = this._fileTexts[this._fileIndex[i]];
    const start = this._byteOffset[i];
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    return text.substring(start, end);
  }

  getName(i) {
    const line = this.getRawLine(i);
    const sep = line.indexOf("|");
    return sep === -1 ? line : line.substring(0, sep);
  }

  getPosition(i, target = new THREE.Vector3()) {
    const idx = i * 3;
    return target.set(this.positions[idx], this.positions[idx + 1], this.positions[idx + 2]);
  }

  // A lightweight, throwaway view mimicking the old { name, data, position }
  // record shape — built only for the single record being inspected, never
  // retained, so it never re-introduces the per-star object/string cost.
  _viewAt(i) {
    const getName = this.getName.bind(this, i);
    const getRawLine = this.getRawLine.bind(this, i);
    const getPosition = this.getPosition.bind(this, i);
    return {
      get name() { return getName(); },
      get data() { return getRawLine(); },
      get position() { return getPosition(); },
    };
  }

  push(entry) {
    this._dynamic.push(entry);
  }

  dynamicEntries() {
    return this._dynamic;
  }

  find(predicate) {
    for (let i = 0; i < this.count; i++) {
      const view = this._viewAt(i);
      if (predicate(view, i)) return view;
    }
    for (const d of this._dynamic) {
      if (predicate(d)) return d;
    }
    return undefined;
  }

  filter(predicate) {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const view = this._viewAt(i);
      if (predicate(view, i)) out.push(view);
    }
    for (const d of this._dynamic) {
      if (predicate(d)) out.push(d);
    }
    return out;
  }
}
