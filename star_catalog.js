import * as THREE from "three";

const HEADER_FIELDS = 9;
const utf8Decoder = new TextDecoder();
const GENERATED_NAME_PATTERN = /^gaia dr3 \d+$/;

export class StarCatalog {
  constructor() {
    this.count = 0;
    this._capacity = 0;
    this.positions = new Float32Array(0);
    this._batchIndex = new Uint16Array(0);
    this._localIndex = new Uint32Array(0);
    this._batches = [];
    this._otypes = [];
    this._spectralTypes = [];
    this._otypeIndexByName = new Map();
    this._spectralTypeIndexByName = new Map();
    this._dynamic = [];
    this._nameIndex = Object.create(null);
    this._allNames = Object.create(null);
  }

  _internOtype(name) {
    let index = this._otypeIndexByName.get(name);
    if (index === undefined) {
      index = this._otypes.length;
      this._otypes.push(name);
      this._otypeIndexByName.set(name, index);
    }
    return index;
  }

  _internSpectralType(name) {
    let index = this._spectralTypeIndexByName.get(name);
    if (index === undefined) {
      index = this._spectralTypes.length;
      this._spectralTypes.push(name);
      this._spectralTypeIndexByName.set(name, index);
    }
    return index;
  }

  _ensureCapacity(additionalCount) {
    const needed = this.count + additionalCount;
    if (needed <= this._capacity) return;
    const newCapacity = Math.max(needed, this._capacity * 2);

    const newPositions = new Float32Array(newCapacity * 3);
    newPositions.set(this.positions.subarray(0, this.count * 3));
    const newBatchIndex = new Uint16Array(newCapacity);
    newBatchIndex.set(this._batchIndex.subarray(0, this.count));
    const newLocalIndex = new Uint32Array(newCapacity);
    newLocalIndex.set(this._localIndex.subarray(0, this.count));

    this.positions = newPositions;
    this._batchIndex = newBatchIndex;
    this._localIndex = newLocalIndex;
    this._capacity = newCapacity;
  }

  build(buffers, dictionaries, onCandidate) {
    this._otypes = dictionaries.otypes.slice();
    this._otypeIndexByName = new Map(this._otypes.map((name, i) => [name, i]));
    this._spectralTypes = dictionaries.spectralTypes.slice();
    this._spectralTypeIndexByName = new Map(this._spectralTypes.map((name, i) => [name, i]));
    this._batches = [];
    this._nameIndex = Object.create(null);
    this._allNames = Object.create(null);

    const positionsArr = [];
    const batchIndexArr = [];
    const localIndexArr = [];
    this._batchIndex = batchIndexArr;
    this._localIndex = localIndexArr;
    this.positions = positionsArr;
    const scratch = new THREE.Vector3();

    for (let b = 0; b < buffers.length; b++) {
      const buffer = buffers[b];
      const header = new Uint32Array(buffer, 0, HEADER_FIELDS);
      const [
        count,
        ,
        positionsOffset,
        otypeCodeOffset,
        spectralTypeIndexOffset,
        nameOffsetsOffset,
        namesBlobOffset,
        namesBlobLength,
        diameterSolarOffset,
      ] = header;

      const positions = new Float32Array(buffer, positionsOffset, count * 3);
      const batch = {
        otypeCode: new Uint16Array(buffer, otypeCodeOffset, count),
        spectralTypeIndex: new Uint16Array(buffer, spectralTypeIndexOffset, count),
        nameOffsets: new Uint32Array(buffer, nameOffsetsOffset, count + 1),
        namesBlob: new Uint8Array(buffer, namesBlobOffset, namesBlobLength),
        diameterSolar: new Float32Array(buffer, diameterSolarOffset, count),
      };
      this._batches.push(batch);

      for (let local = 0; local < count; local++) {
        scratch.set(positions[local * 3], positions[local * 3 + 1], positions[local * 3 + 2]);
        const index = batchIndexArr.length;
        batchIndexArr.push(b);
        localIndexArr.push(local);
        positionsArr.push(scratch.x, scratch.y, scratch.z);
        // getName(index) already resolves correctly here — _batchIndex/
        // _localIndex were assigned by reference before this loop started
        // (see the comment above), same reasoning onCandidate below relies on.
        // Generated "Gaia DR3 <id>" names are skipped — see
        // GENERATED_NAME_PATTERN's comment.
        const indexedName = this.getName(index).toLowerCase().trim();
        this._allNames[indexedName] = index;
        if (!GENERATED_NAME_PATTERN.test(indexedName)) this._nameIndex[indexedName] = index;
        if (onCandidate) onCandidate(scratch, index);
      }
    }

    this.count = batchIndexArr.length;
    this.positions = Float32Array.from(positionsArr);
    this._batchIndex = Uint16Array.from(batchIndexArr);
    this._localIndex = Uint32Array.from(localIndexArr);
    this._capacity = this.count;
  }

  addBatch(buffer, dictionaries, onCandidate) {
    const otypeRemap = dictionaries.otypes.map((name) => this._internOtype(name));
    const spectralTypeRemap = dictionaries.spectralTypes.map((name) => this._internSpectralType(name));

    const header = new Uint32Array(buffer, 0, HEADER_FIELDS);
    const [
      count,
      ,
      positionsOffset,
      otypeCodeOffset,
      spectralTypeIndexOffset,
      nameOffsetsOffset,
      namesBlobOffset,
      namesBlobLength,
      diameterSolarOffset,
    ] = header;

    const positions = new Float32Array(buffer, positionsOffset, count * 3);
    const otypeCode = new Uint16Array(buffer, otypeCodeOffset, count);
    const spectralTypeIndex = new Uint16Array(buffer, spectralTypeIndexOffset, count);
    const nameOffsets = new Uint32Array(buffer, nameOffsetsOffset, count + 1);
    const namesBlob = new Uint8Array(buffer, namesBlobOffset, namesBlobLength);
    const diameterSolar = new Float32Array(buffer, diameterSolarOffset, count);

    const keptLocals = [];
    for (let local = 0; local < count; local++) {
      const name = utf8Decoder.decode(namesBlob.subarray(nameOffsets[local], nameOffsets[local + 1]));
      const key = name.toLowerCase().trim();
      if (!(key in this._allNames)) keptLocals.push(local);
    }
    if (keptLocals.length === 0) return;

    for (const local of keptLocals) {
      otypeCode[local] = otypeRemap[otypeCode[local]];
      spectralTypeIndex[local] = spectralTypeRemap[spectralTypeIndex[local]];
    }

    const batchIdx = this._batches.length;
    this._batches.push({ otypeCode, spectralTypeIndex, nameOffsets, namesBlob, diameterSolar });

    const startIndex = this.count;
    this._ensureCapacity(keptLocals.length);

    const scratch = new THREE.Vector3();
    keptLocals.forEach((local, offset) => {
      const index = startIndex + offset;
      this._batchIndex[index] = batchIdx;
      this._localIndex[index] = local;
      this.positions[index * 3] = positions[local * 3];
      this.positions[index * 3 + 1] = positions[local * 3 + 1];
      this.positions[index * 3 + 2] = positions[local * 3 + 2];
    });

    this.count = startIndex + keptLocals.length;

    keptLocals.forEach((local, offset) => {
      const index = startIndex + offset;
      const indexedName = this.getName(index).toLowerCase().trim();
      this._allNames[indexedName] = index;
      if (!GENERATED_NAME_PATTERN.test(indexedName)) this._nameIndex[indexedName] = index;
      if (onCandidate) onCandidate(this.getPosition(index, scratch), index);
    });
  }

  getName(i) {
    const batch = this._batches[this._batchIndex[i]];
    const local = this._localIndex[i];
    const start = batch.nameOffsets[local];
    const end = batch.nameOffsets[local + 1];
    return utf8Decoder.decode(batch.namesBlob.subarray(start, end));
  }

  getOtype(i) {
    const batch = this._batches[this._batchIndex[i]];
    return this._otypes[batch.otypeCode[this._localIndex[i]]] || "";
  }

  getSpectralType(i) {
    const batch = this._batches[this._batchIndex[i]];
    return this._spectralTypes[batch.spectralTypeIndex[this._localIndex[i]]] || "";
  }

  getDiameterSolar(i) {
    const batch = this._batches[this._batchIndex[i]];
    return batch.diameterSolar[this._localIndex[i]];
  }

  getPosition(i, target = new THREE.Vector3()) {
    const idx = i * 3;
    return target.set(this.positions[idx], this.positions[idx + 1], this.positions[idx + 2]);
  }

  // A lightweight, throwaway view mimicking the old { name, data, position }
  // record shape — built only for the single record being inspected, never
  // retained, so it never re-introduces the per-star object/string cost.
  _viewAt(i) {
    return {
      get name() { return this._catalog.getName(this._index); },
      get otype() { return this._catalog.getOtype(this._index); },
      get spectralType() { return this._catalog.getSpectralType(this._index); },
      get position() { return this._catalog.getPosition(this._index); },
      get diameterSolar() { return this._catalog.getDiameterSolar(this._index); },
      _catalog: this,
      _index: i,
    };
  }

  push(entry) {
    this._dynamic.push(entry);
  }

  dynamicEntries() {
    return this._dynamic;
  }

  findByName(name) {
    if (!name) return undefined;
    const key = name.toLowerCase().trim();
    const index = this._nameIndex[key];
    if (index !== undefined) return this._viewAt(index);
    for (let i = 0; i < this.count; i++) {
      if (this.getName(i).toLowerCase().trim() === key) return this._viewAt(i);
    }
    return this._dynamic.find((d) => d.name && d.name.toLowerCase().trim() === key);
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
