
export const HEADER_FIELDS = 8; // count, positionsOffset, otypeCodeOffset,
// spectralTypeIndexOffset, nameOffsetsOffset, namesBlobOffset, namesBlobLength,
// diameterSolarOffset
const HEADER_BYTES = HEADER_FIELDS * 4;

// Sun-centered xyz in light-years, precomputed and stored on the row (see
// stars.x_ly/y_ly/z_ly in scripts/db.js — filled from ra/dec/distance at
// sync time; those source columns no longer live in the built db).
export function positionFor(row) {
  return { x: row.x_ly, y: row.y_ly, z: row.z_ly };
}

export function nameFor(row) {
  return row.main_id;
}

class SectionWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
  }

  // Pads to a 4-byte boundary, appends `buf`, and returns the (4-aligned)
  // byte offset it was written at — so client-side TypedArray views never
  // need a copy to be constructed directly over the fetched ArrayBuffer.
  push(buf) {
    const pad = (4 - (this.offset % 4)) % 4;
    if (pad > 0) {
      this.chunks.push(Buffer.alloc(pad));
      this.offset += pad;
    }
    const start = this.offset;
    this.chunks.push(buf);
    this.offset += buf.length;
    return start;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.offset);
  }
}

export function spectralTypeFor(row) {
  return row.sp_type || "M";
}

export function createDictionaries() {
  return { otypes: [], otypeIndex: new Map(), spectralTypes: [], spectralTypeIndex: new Map() };
}

// Mutates `dictionaries` in place with any (otype, spectralType) values from
// `rows` not already known.
export function addToDictionaries(rows, dictionaries) {
  for (const row of rows) {
    const otype = row.otype || "";
    if (!dictionaries.otypeIndex.has(otype)) {
      dictionaries.otypeIndex.set(otype, dictionaries.otypes.length);
      dictionaries.otypes.push(otype);
    }
    const spType = spectralTypeFor(row);
    if (!dictionaries.spectralTypeIndex.has(spType)) {
      dictionaries.spectralTypeIndex.set(spType, dictionaries.spectralTypes.length);
      dictionaries.spectralTypes.push(spType);
    }
  }
}

export function buildBatchBuffer(rows, dictionaries) {
  const count = rows.length;
  const positions = new Float32Array(count * 3);
  const otypeCode = new Uint16Array(count);
  const spectralTypeIndex = new Uint16Array(count);
  const diameterSolar = new Float32Array(count); // 0 = no measurement
  const nameOffsets = new Uint32Array(count + 1);
  const nameBytesChunks = [];
  let nameByteLength = 0;

  rows.forEach((row, i) => {
    const p = positionFor(row);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    otypeCode[i] = dictionaries.otypeIndex.get(row.otype || "");
    spectralTypeIndex[i] = dictionaries.spectralTypeIndex.get(spectralTypeFor(row));
    diameterSolar[i] = row.diameter_solar || 0;

    const nameBuf = Buffer.from(nameFor(row), "utf8");
    nameOffsets[i] = nameByteLength;
    nameBytesChunks.push(nameBuf);
    nameByteLength += nameBuf.length;
  });
  nameOffsets[count] = nameByteLength;
  const namesBlob = Buffer.concat(nameBytesChunks, nameByteLength);

  const writer = new SectionWriter();
  writer.push(Buffer.alloc(HEADER_BYTES)); // reserve space, filled in below
  const positionsOffset = writer.push(Buffer.from(positions.buffer));
  const otypeCodeOffset = writer.push(Buffer.from(otypeCode.buffer));
  const spectralTypeIndexOffset = writer.push(Buffer.from(spectralTypeIndex.buffer));
  const diameterSolarOffset = writer.push(Buffer.from(diameterSolar.buffer));
  const nameOffsetsOffset = writer.push(Buffer.from(nameOffsets.buffer));
  const namesBlobOffset = writer.push(namesBlob);

  const raw = writer.toBuffer();
  const out = Buffer.allocUnsafeSlow(raw.length);
  raw.copy(out);
  const header = new Uint32Array(
    out.buffer,
    out.byteOffset,
    HEADER_FIELDS,
  );
  header[0] = count;
  header[1] = positionsOffset;
  header[2] = otypeCodeOffset;
  header[3] = spectralTypeIndexOffset;
  header[4] = nameOffsetsOffset;
  header[5] = namesBlobOffset;
  header[6] = namesBlob.length;
  header[7] = diameterSolarOffset;
  return out;
}
