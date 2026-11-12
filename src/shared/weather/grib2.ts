/**
 * Minimal, dependency-free GRIB2 decoder (WMO FM 92 GRIB edition 2).
 *
 * Built for NOAA GFS fields cut out of the big pgrb2 files with HTTP range
 * requests, so it supports only what those use:
 *   - grid template 3.0 (regular lat/lon)
 *   - product templates 4.0 (instantaneous) and 4.8 (statistically processed)
 *   - data templates 5.0 (simple packing), 5.2 (complex packing) and 5.3
 *     (complex packing with 1st/2nd order spatial differencing), including the
 *     missing-value management options
 *   - section 6 bitmaps (indicator 0 = present, 254 = reuse previous, 255 = none)
 * Anything else throws an Error naming the unsupported template.
 *
 * Decoding follows NCEP g2clib (simunpack/comunpack), which matches eccodes:
 *   value = (R + X * 2^E) / 10^D
 * where R is the IEEE float reference value, E the binary and D the decimal
 * scale factor. Pure TypeScript: no Node or DOM APIs, so it runs in browsers
 * and Workers alike.
 */

export interface Grib2Field {
  /** Product discipline (section 0), parameter category and number (section 4). TCDC = 0/6/1. */
  discipline: number;
  category: number;
  parameter: number;
  /** Product definition template number: 0 = instantaneous, 8 = average/accumulation. */
  productTemplate: number;
  /** Reference (cycle) time from section 1, ms since epoch (UTC). */
  referenceTime: number;
  /** Forecast time in hours. For template 4.8 this is the START of the statistical interval. */
  forecastHours: number;
  /** Hours from referenceTime to the end of the statistical interval (4.8); equals forecastHours for 4.0. */
  forecastEndHours: number;
  /** Grid size: nx points along a parallel, ny along a meridian. */
  nx: number;
  ny: number;
  /** First/last grid point and increments, in degrees. */
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  dx: number;
  dy: number;
  /** Scanning mode flags (code table 3.4). 0 = rows west→east, starting at the north, row-major. */
  scanMode: number;
  /** nx*ny values in the file's scan order; NaN where the bitmap or missing-value management marks missing. */
  values: Float32Array;
}

/** Hours per unit for code table 4.4 (indicator of unit of time range). Months/years are not convertible. */
const HOURS_PER_TIME_UNIT: Record<number, number> = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600 };

/** Names for data representation templates we refuse, to make the error actionable. */
const DATA_TEMPLATE_NAMES: Record<number, string> = {
  4: 'IEEE floating point',
  40: 'JPEG2000',
  41: 'PNG',
  42: 'CCSDS/AEC',
  50: 'spectral simple packing',
  51: 'spectral complex packing',
  61: 'simple packing with logarithm pre-processing',
  200: 'run-length packing',
};

const MS_PER_HOUR = 3_600_000;

interface Grid {
  numPoints: number;
  nx: number;
  ny: number;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  dx: number;
  dy: number;
  scanMode: number;
}

interface Product {
  template: number;
  category: number;
  parameter: number;
  forecastHours: number;
  /** End of the overall time interval (template 4.8 only), ms since epoch. */
  endTime: number | null;
}

interface Packing {
  template: number; // 0, 2 or 3
  numValues: number; // values actually packed in section 7 (bitmapped points excluded)
  R: number;
  E: number;
  D: number;
  nbits: number; // bits per value (5.0) / per group reference value (5.2, 5.3)
  // Complex packing (5.2/5.3) only; zero for 5.0.
  missingMgmt: number; // 0 none, 1 primary, 2 primary + secondary
  ngroups: number;
  widthRef: number;
  widthBits: number;
  lengthRef: number;
  lengthInc: number;
  lastLength: number;
  lengthBits: number;
  sdOrder: number; // spatial differencing order, 5.3 only
  sdOctets: number; // octets per extra descriptor in section 7, 5.3 only
}

/** Decode every GRIB2 message in `bytes` (one or several concatenated) into fields. */
export function decodeGrib2(bytes: Uint8Array): Grib2Field[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: Grib2Field[] = [];
  let offset = findMagic(bytes, 0);
  if (offset < 0) throw new Error('GRIB2: no "GRIB" message found in buffer');
  while (offset >= 0) {
    offset = findMagic(bytes, offset + decodeMessage(bytes, view, offset, fields));
  }
  return fields;
}

function findMagic(b: Uint8Array, from: number): number {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === 0x47 && b[i + 1] === 0x52 && b[i + 2] === 0x49 && b[i + 3] === 0x42) return i;
  }
  return -1;
}

/** Decode one message starting at `start`, appending its field(s) to `out`. Returns the message length. */
function decodeMessage(bytes: Uint8Array, view: DataView, start: number, out: Grib2Field[]): number {
  if (start + 16 > bytes.length) throw new Error(`GRIB2: truncated section 0 at byte ${start}`);
  const edition = view.getUint8(start + 7);
  if (edition !== 2) throw new Error(`GRIB2: unsupported GRIB edition ${edition} at byte ${start}`);
  const discipline = view.getUint8(start + 6);
  const length = view.getUint32(start + 8) * 2 ** 32 + view.getUint32(start + 12);
  const end = start + length;
  if (end > bytes.length) {
    throw new Error(`GRIB2: message at byte ${start} declares ${length} bytes but only ${bytes.length - start} are present`);
  }
  if (view.getUint32(end - 4) !== 0x37373737) throw new Error(`GRIB2: message at byte ${start} does not end with "7777"`);

  // Sections 2-7 (or 3-7, 4-7) may repeat within a message; each section 7 completes one field
  // using the most recent sections of each kind.
  let referenceTime: number | null = null;
  let grid: Grid | null = null;
  let product: Product | null = null;
  let packing: Packing | null = null;
  let bitmap: Uint8Array | null = null;
  let previousBitmap: Uint8Array | null = null;

  let pos = start + 16;
  while (pos < end - 4) {
    const len = view.getUint32(pos);
    const section = view.getUint8(pos + 4);
    if (len < 5 || pos + len > end - 4) throw new Error(`GRIB2: bad length ${len} for section ${section} at byte ${pos}`);
    const at = (octet: number) => pos + octet - 1; // spec octets are 1-based within the section

    switch (section) {
      case 1:
        referenceTime = Date.UTC(
          view.getUint16(at(13)), view.getUint8(at(15)) - 1, view.getUint8(at(16)),
          view.getUint8(at(17)), view.getUint8(at(18)), view.getUint8(at(19)),
        );
        break;
      case 2: // local use: ignored
        break;
      case 3:
        grid = parseGrid(view, at);
        break;
      case 4:
        product = parseProduct(view, at);
        break;
      case 5:
        packing = parsePacking(view, at);
        break;
      case 6: {
        const indicator = view.getUint8(at(6));
        if (indicator === 0) bitmap = previousBitmap = bytes.subarray(at(7), pos + len);
        else if (indicator === 255) bitmap = null;
        else if (indicator === 254 && previousBitmap) bitmap = previousBitmap;
        else throw new Error(`GRIB2: unsupported bitmap indicator ${indicator} (predefined bitmaps are not supported)`);
        break;
      }
      case 7: {
        if (referenceTime === null || !grid || !product || !packing) {
          throw new Error(`GRIB2: section 7 at byte ${pos} is not preceded by sections 1, 3, 4 and 5`);
        }
        const packed = unpack(bytes, at(6), pos + len, packing);
        const values = bitmap ? applyBitmap(packed, bitmap, grid.numPoints) : packed;
        if (values.length !== grid.numPoints) {
          throw new Error(`GRIB2: ${values.length} values decoded but the grid has ${grid.numPoints} points`);
        }
        out.push({
          discipline,
          category: product.category,
          parameter: product.parameter,
          productTemplate: product.template,
          referenceTime,
          forecastHours: product.forecastHours,
          forecastEndHours: product.endTime === null ? product.forecastHours : (product.endTime - referenceTime) / MS_PER_HOUR,
          nx: grid.nx, ny: grid.ny,
          lat1: grid.lat1, lon1: grid.lon1, lat2: grid.lat2, lon2: grid.lon2,
          dx: grid.dx, dy: grid.dy,
          scanMode: grid.scanMode,
          values,
        });
        break;
      }
      default:
        throw new Error(`GRIB2: unexpected section number ${section} at byte ${pos}`);
    }
    pos += len;
  }
  return length;
}

// GRIB2 signed integers are sign-magnitude (top bit = sign), not two's complement.
function int16(view: DataView, offset: number): number {
  const v = view.getUint16(offset);
  return v & 0x8000 ? -(v & 0x7fff) : v;
}
function int32(view: DataView, offset: number): number {
  const v = view.getUint32(offset);
  return v >= 0x80000000 ? -(v - 0x80000000) : v;
}

/** Section 3: grid definition. Only template 3.0 (regular lat/lon). */
function parseGrid(view: DataView, at: (octet: number) => number): Grid {
  if (view.getUint8(at(6)) !== 0) throw new Error('GRIB2: predetermined grid definitions (section 3 octet 6 != 0) are not supported');
  if (view.getUint8(at(11)) !== 0) throw new Error('GRIB2: quasi-regular grids (optional list of points) are not supported');
  const template = view.getUint16(at(13));
  if (template !== 0) throw new Error(`GRIB2: unsupported grid definition template 3.${template} (only 3.0 regular lat/lon is supported)`);

  const numPoints = view.getUint32(at(7));
  const nx = view.getUint32(at(31));
  const ny = view.getUint32(at(35));
  // Angles are in micro-degrees unless a basic angle/subdivision pair is given.
  const basicAngle = view.getUint32(at(39));
  const subdivisions = view.getUint32(at(43));
  const microDegrees = basicAngle === 0 || basicAngle === 0xffffffff;
  const deg = (v: number) => (microDegrees ? v / 1e6 : (v * basicAngle) / subdivisions);
  const increment = (offset: number) => {
    const v = view.getUint32(offset);
    return v === 0xffffffff ? NaN : deg(v);
  };

  if (nx * ny !== numPoints) throw new Error(`GRIB2: grid is ${nx}x${ny} but declares ${numPoints} points`);
  return {
    numPoints, nx, ny,
    lat1: deg(int32(view, at(47))),
    lon1: deg(int32(view, at(51))),
    lat2: deg(int32(view, at(56))),
    lon2: deg(int32(view, at(60))),
    dx: increment(at(64)),
    dy: increment(at(68)),
    scanMode: view.getUint8(at(72)),
  };
}

/** Section 4: product definition. Templates 4.0 and 4.8 share octets 10-34. */
function parseProduct(view: DataView, at: (octet: number) => number): Product {
  const template = view.getUint16(at(8));
  if (template !== 0 && template !== 8) {
    throw new Error(`GRIB2: unsupported product definition template 4.${template} (only 4.0 and 4.8 are supported)`);
  }
  const unit = view.getUint8(at(18));
  const hoursPerUnit = HOURS_PER_TIME_UNIT[unit];
  if (hoursPerUnit === undefined) throw new Error(`GRIB2: unsupported time unit ${unit} (code table 4.4)`);
  const endTime = template === 8
    ? Date.UTC(
      view.getUint16(at(35)), view.getUint8(at(37)) - 1, view.getUint8(at(38)),
      view.getUint8(at(39)), view.getUint8(at(40)), view.getUint8(at(41)),
    )
    : null;
  return {
    template,
    category: view.getUint8(at(10)),
    parameter: view.getUint8(at(11)),
    forecastHours: int32(view, at(19)) * hoursPerUnit,
    endTime,
  };
}

/** Section 5: data representation. */
function parsePacking(view: DataView, at: (octet: number) => number): Packing {
  const template = view.getUint16(at(10));
  if (template !== 0 && template !== 2 && template !== 3) {
    const name = DATA_TEMPLATE_NAMES[template];
    throw new Error(
      `GRIB2: unsupported data representation template 5.${template}${name ? ` (${name})` : ''}; only 5.0, 5.2 and 5.3 are supported`,
    );
  }
  const complex = template !== 0;
  const p: Packing = {
    template,
    numValues: view.getUint32(at(6)),
    R: view.getFloat32(at(12)),
    E: int16(view, at(16)),
    D: int16(view, at(18)),
    nbits: view.getUint8(at(20)),
    // Octets 24-31 (missing value substitutes) are not needed: missing points decode to NaN.
    missingMgmt: complex ? view.getUint8(at(23)) : 0,
    ngroups: complex ? view.getUint32(at(32)) : 0,
    widthRef: complex ? view.getUint8(at(36)) : 0,
    widthBits: complex ? view.getUint8(at(37)) : 0,
    lengthRef: complex ? view.getUint32(at(38)) : 0,
    lengthInc: complex ? view.getUint8(at(42)) : 0,
    lastLength: complex ? view.getUint32(at(43)) : 0,
    lengthBits: complex ? view.getUint8(at(47)) : 0,
    sdOrder: template === 3 ? view.getUint8(at(48)) : 0,
    sdOctets: template === 3 ? view.getUint8(at(49)) : 0,
  };
  if (p.missingMgmt > 2) throw new Error(`GRIB2: unsupported missing value management ${p.missingMgmt}`);
  if (template === 3 && p.sdOrder !== 1 && p.sdOrder !== 2) {
    throw new Error(`GRIB2: unsupported spatial differencing order ${p.sdOrder}`);
  }
  return p;
}

/** Big-endian bit reader over [startByte, endByte) of a buffer. */
class BitReader {
  private readonly bytes: Uint8Array;
  private readonly endBit: number;
  private bit: number;
  constructor(bytes: Uint8Array, startByte: number, endByte: number) {
    this.bytes = bytes;
    this.bit = startByte * 8;
    this.endBit = endByte * 8;
  }
  /** Throw unless at least `n` more bits are available, so the hot loops can skip bounds checks. */
  ensure(n: number): void {
    if (this.bit + n > this.endBit) throw new Error('GRIB2: section 7 is shorter than its packing parameters require');
  }
  /** Read an unsigned integer of `n` bits (n <= 53). */
  read(n: number): number {
    let value = 0;
    let bit = this.bit;
    let left = n;
    while (left > 0) {
      const used = bit & 7;
      const take = Math.min(8 - used, left);
      const chunk = (this.bytes[bit >>> 3]! >>> (8 - used - take)) & ((1 << take) - 1);
      value = value * (1 << take) + chunk;
      bit += take;
      left -= take;
    }
    this.bit = bit;
    return value;
  }
  /** Sign-magnitude integer of `n` bits. */
  readSigned(n: number): number {
    const negative = this.read(1) === 1;
    const magnitude = this.read(n - 1);
    return negative ? -magnitude : magnitude;
  }
  /** Read `count` values of `n` bits, then skip to the next octet boundary. */
  readList(count: number, n: number): Float64Array {
    const list = new Float64Array(count);
    if (n === 0) return list;
    this.ensure(count * n);
    for (let i = 0; i < count; i++) list[i] = this.read(n);
    this.bit = Math.ceil(this.bit / 8) * 8;
    return list;
  }
}

/** Unpack section 7 into `p.numValues` floats (NaN for values flagged missing by 5.2/5.3). */
function unpack(bytes: Uint8Array, startByte: number, endByte: number, p: Packing): Float32Array {
  const n = p.numValues;
  const out = new Float32Array(n);
  const binary = 2 ** p.E;
  const decimal = 10 ** p.D;
  const reader = new BitReader(bytes, startByte, endByte);

  // Constant fields: g2clib and eccodes return R itself (no decimal scaling) when nothing is packed.
  if (p.template === 0 ? p.nbits === 0 : p.ngroups === 0) return out.fill(p.R);

  if (p.template === 0) {
    reader.ensure(n * p.nbits);
    for (let i = 0; i < n; i++) out[i] = (p.R + reader.read(p.nbits) * binary) / decimal;
    return out;
  }

  // 1. Spatial differencing descriptors (5.3): first value(s) and the overall minimum of the differences.
  let first1 = 0;
  let first2 = 0;
  let minDiff = 0;
  if (p.template === 3 && p.sdOctets > 0) {
    const bits = p.sdOctets * 8;
    reader.ensure(bits * (p.sdOrder + 1));
    first1 = reader.readSigned(bits);
    if (p.sdOrder === 2) first2 = reader.readSigned(bits);
    minDiff = reader.readSigned(bits);
  }

  // 2. Per-group reference values, bit widths and lengths, each list padded to an octet boundary.
  const ng = p.ngroups;
  const refs = reader.readList(ng, p.nbits);
  const widths = reader.readList(ng, p.widthBits);
  const lengths = reader.readList(ng, p.lengthBits);
  let total = 0;
  for (let g = 0; g < ng; g++) {
    widths[g] = widths[g]! + p.widthRef;
    lengths[g] = g === ng - 1 ? p.lastLength : lengths[g]! * p.lengthInc + p.lengthRef;
    total += lengths[g]!;
  }
  if (total !== n) throw new Error(`GRIB2: group lengths sum to ${total} but section 5 declares ${n} values`);

  // 3. Group values. Non-missing integers are compacted to the front of `ints` (as in g2clib), since
  //    spatial differencing runs over the non-missing sequence only.
  const ints = new Float64Array(n);
  const missing = p.missingMgmt > 0 ? new Uint8Array(n) : null;
  let k = 0; // point index
  let m = 0; // non-missing index
  for (let g = 0; g < ng; g++) {
    const width = widths[g]!;
    const len = lengths[g]!;
    const ref = refs[g]!;
    if (width === 0) {
      // Constant group; with missing management an all-ones reference marks the whole group missing.
      const allOnes = 2 ** p.nbits - 1;
      const flag = !missing ? 0 : ref === allOnes ? 1 : p.missingMgmt === 2 && ref === allOnes - 1 ? 2 : 0;
      if (flag) {
        missing!.fill(flag, k, k + len);
      } else {
        ints.fill(ref, m, m + len);
        m += len;
      }
      k += len;
      continue;
    }
    reader.ensure(width * len);
    if (!missing) {
      for (let i = 0; i < len; i++) ints[m++] = reader.read(width) + ref;
      k += len;
      continue;
    }
    const miss1 = 2 ** width - 1; // all ones = primary missing, all ones minus one = secondary
    for (let i = 0; i < len; i++, k++) {
      const x = reader.read(width);
      if (x === miss1) missing[k] = 1;
      else if (p.missingMgmt === 2 && x === miss1 - 1) missing[k] = 2;
      else ints[m++] = x + ref;
    }
  }

  // 4. Undo spatial differencing: restore the first value(s), then integrate the differences.
  if (p.template === 3) {
    if (m > 0) ints[0] = first1;
    if (p.sdOrder === 1) {
      for (let i = 1; i < m; i++) ints[i] = ints[i]! + minDiff + ints[i - 1]!;
    } else {
      if (m > 1) ints[1] = first2;
      for (let i = 2; i < m; i++) ints[i] = ints[i]! + minDiff + 2 * ints[i - 1]! - ints[i - 2]!;
    }
  }

  // 5. Scale, re-inserting missing points.
  for (let i = 0, j = 0; i < n; i++) {
    out[i] = missing && missing[i] ? NaN : (p.R + ints[j++]! * binary) / decimal;
  }
  return out;
}

/** Expand packed values onto the full grid: bitmap bit 1 = value present, 0 = missing (NaN). */
function applyBitmap(packed: Float32Array, bitmap: Uint8Array, numPoints: number): Float32Array {
  if (bitmap.length * 8 < numPoints) throw new Error(`GRIB2: bitmap covers ${bitmap.length * 8} points, grid has ${numPoints}`);
  const values = new Float32Array(numPoints);
  let j = 0;
  for (let i = 0; i < numPoints; i++) {
    values[i] = bitmap[i >>> 3]! & (0x80 >>> (i & 7)) ? packed[j++]! : NaN;
  }
  if (j !== packed.length) throw new Error(`GRIB2: bitmap marks ${j} points present but ${packed.length} values are packed`);
  return values;
}
