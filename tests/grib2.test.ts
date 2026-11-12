import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGrib2 } from '../src/shared/weather/grib2';

/*
 * Fixtures
 *
 * gfs-tcdc-1p00.grb2: one real message, "TCDC:entire atmosphere:6 hour fcst" from the GFS
 * 2026-11-10 00Z cycle, forecast hour 6, 1° grid (template 3.0, 5.3 complex packing with
 * 2nd-order spatial differencing). Line 636 of the matching .idx gives the byte range:
 *   curl -r 37502875-37573441 \
 *     https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261110/00/atmos/gfs.t00z.pgrb2.1p00.f006
 *
 * gfs-tcdc-1p00.reference.json: metadata, min/max/mean and ~300 sampled (index, value) pairs
 * from eccodes 2.50 (codes_get_values) for that message.
 *
 * gfs-tcdc-variants.grb2: eight small messages written by eccodes 2.50. Each is the fixture
 * subsampled to a 10° 36x19 grid (every 10th row and column), re-encoded as:
 *   0: 5.0 simple packing              1: 5.2 complex packing
 *   2: 5.3 1st-order differencing       3: 5.3 2nd-order + bitmap, product template 4.8 (0-6 h average)
 *   4: 5.2 + missing value management   5: 5.3 1st-order + missing value management
 *   6: 5.0 constant field (42.5)        7: 5.3 constant field (42.5)
 * Variants 3-5 mark the north-pole row and every 7th point missing. When the file was generated,
 * decodeGrib2 matched eccodes on every variant to within 3e-6, with identical missing points.
 * eccodes packs 1-5 with binary scale factor -5, so they differ from the 1° values by up to 1/64.
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const readBytes = (name: string) => new Uint8Array(readFileSync(fixture(name)));

interface Reference {
  discipline: number; category: number; parameter: number;
  nx: number; ny: number;
  lat1: number; lon1: number; lat2: number; lon2: number; dx: number; dy: number;
  scanMode: number; referenceTime: number; forecastHours: number;
  min: number; max: number; mean: number;
  samples: [index: number, value: number][];
}
const reference = JSON.parse(readFileSync(fixture('gfs-tcdc-1p00.reference.json'), 'utf8')) as Reference;
const gfs = readBytes('gfs-tcdc-1p00.grb2');

/** Byte offset of the first section with the given number in a single message. */
function sectionOffset(msg: Uint8Array, section: number): number {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  for (let pos = 16; pos < msg.length - 4; pos += view.getUint32(pos)) {
    if (msg[pos + 4] === section) return pos;
  }
  throw new Error(`section ${section} not found`);
}

/** Copy of `msg` with a 2-byte template number (octets 1-based within the section) overwritten. */
function patchTemplate(msg: Uint8Array, section: number, octet: number, template: number): Uint8Array {
  const copy = msg.slice();
  new DataView(copy.buffer).setUint16(sectionOffset(copy, section) + octet - 1, template);
  return copy;
}

describe('decodeGrib2: GFS 1° total cloud cover', () => {
  const fields = decodeGrib2(gfs);
  const field = fields[0]!;

  it('decodes one field with the grid and product metadata eccodes reports', () => {
    expect(fields).toHaveLength(1);
    expect(field).toMatchObject({
      discipline: reference.discipline,
      category: reference.category,
      parameter: reference.parameter,
      productTemplate: 0,
      referenceTime: reference.referenceTime,
      forecastHours: reference.forecastHours,
      forecastEndHours: reference.forecastHours,
      nx: reference.nx, ny: reference.ny,
      lat1: reference.lat1, lon1: reference.lon1, lat2: reference.lat2, lon2: reference.lon2,
      dx: reference.dx, dy: reference.dy,
      scanMode: reference.scanMode,
    });
    expect(new Date(field.referenceTime).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(field.values).toBeInstanceOf(Float32Array);
    expect(field.values.length).toBe(360 * 181);
  });

  it('matches eccodes values within 1e-3', () => {
    for (const [index, value] of reference.samples) {
      expect(Math.abs(field.values[index]! - value), `index ${index}`).toBeLessThan(1e-3);
    }
    expect(reference.samples[0]![0]).toBe(0);
    expect(reference.samples.at(-1)![0]).toBe(field.values.length - 1);

    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of field.values) {
      expect(Number.isFinite(v)).toBe(true);
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    expect(Math.abs(min - reference.min)).toBeLessThan(1e-3);
    expect(Math.abs(max - reference.max)).toBeLessThan(1e-3);
    expect(Math.abs(sum / field.values.length - reference.mean)).toBeLessThan(1e-3);
  });

  it('decodes concatenated messages into one field each', () => {
    const two = new Uint8Array(gfs.length * 2);
    two.set(gfs, 0);
    two.set(gfs, gfs.length);
    const decoded = decodeGrib2(two);
    expect(decoded).toHaveLength(2);
    expect(decoded[1]!.values).toEqual(field.values);
  });
});

describe('decodeGrib2: packing variants', () => {
  const full = decodeGrib2(gfs)[0]!.values;
  const fields = decodeGrib2(readBytes('gfs-tcdc-variants.grb2'));
  // Expected 36x19 field: every 10th row and column of the 1° grid.
  const expected = Float32Array.from({ length: 36 * 19 }, (_, i) => full[Math.floor(i / 36) * 3600 + (i % 36) * 10]!);
  const isMissing = (i: number) => i < 36 || i % 7 === 0;

  it('decodes all eight messages on the 10° grid', () => {
    expect(fields).toHaveLength(8);
    for (const f of fields) {
      expect(f).toMatchObject({ nx: 36, ny: 19, lat1: 90, lon1: 0, lat2: -90, lon2: 350, dx: 10, dy: 10, scanMode: 0 });
    }
  });

  it.each([
    [0, '5.0 simple packing', false],
    [1, '5.2 complex packing', false],
    [2, '5.3 1st-order spatial differencing', false],
    [3, '5.3 2nd-order + bitmap', true],
    [4, '5.2 + missing value management', true],
    [5, '5.3 1st-order + missing value management', true],
  ] as const)('variant %i (%s) reproduces the subsampled field', (index, _name, hasMissing) => {
    const values = fields[index]!.values;
    for (let i = 0; i < values.length; i++) {
      if (hasMissing && isMissing(i)) {
        expect(values[i], `point ${i}`).toBeNaN();
      } else {
        expect(Math.abs(values[i]! - expected[i]!), `point ${i}`).toBeLessThanOrEqual(1 / 64 + 1e-6);
      }
    }
  });

  it('reads product template 4.8 as a 0-6 h interval', () => {
    expect(fields[3]).toMatchObject({ productTemplate: 8, forecastHours: 0, forecastEndHours: 6 });
  });

  it('returns the reference value for constant fields', () => {
    for (const f of [fields[6]!, fields[7]!]) expect(new Set(f.values)).toEqual(new Set([42.5]));
  });
});

describe('decodeGrib2: errors', () => {
  it('rejects unsupported data representation templates', () => {
    expect(() => decodeGrib2(patchTemplate(gfs, 5, 10, 40))).toThrow(
      /unsupported data representation template 5\.40 \(JPEG2000\)/,
    );
    expect(() => decodeGrib2(patchTemplate(gfs, 5, 10, 41))).toThrow(/5\.41 \(PNG\)/);
  });

  it('rejects unsupported grid and product templates', () => {
    expect(() => decodeGrib2(patchTemplate(gfs, 3, 13, 30))).toThrow(/unsupported grid definition template 3\.30/);
    expect(() => decodeGrib2(patchTemplate(gfs, 4, 8, 1))).toThrow(/unsupported product definition template 4\.1/);
  });

  it('rejects truncated input and non-GRIB bytes', () => {
    expect(() => decodeGrib2(gfs.subarray(0, 1000))).toThrow(/declares 70567 bytes but only 1000 are present/);
    expect(() => decodeGrib2(new TextEncoder().encode('<Error>NoSuchKey</Error>'))).toThrow(/no "GRIB" message/);
  });
});
