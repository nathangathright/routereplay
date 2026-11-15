import { describe, expect, it } from 'vitest';
import { COVER_LEVELS, EROSION, EROSION_OFFSET, EROSION_SCALE, SHAPE_SIZE, cellularShapes, coverTables, lobe, sampleShape, seeded } from '../src/app/render/cloudShapes';

const { rgba } = cellularShapes();
const tables = coverTables(rgba);
const shapeAt = (x: number, y: number, z: number) =>
  sampleShape(rgba, x, y, z) - EROSION * (1 - sampleShape(rgba, x * EROSION_SCALE + EROSION_OFFSET, y * EROSION_SCALE + EROSION_OFFSET, z * EROSION_SCALE + EROSION_OFFSET));

describe('cellular billows', () => {
  it('is the same every time it is built', () => {
    expect(cellularShapes().rgba).toEqual(rgba);
  });

  it('tiles: sampling a whole tile away gives the same value', () => {
    const rand = seeded(7);
    for (let i = 0; i < 200; i++) {
      const [x, y, z] = [rand(), rand(), rand()];
      expect(sampleShape(rgba, x + 1, y - 1, z + 2)).toBeCloseTo(sampleShape(rgba, x, y, z), 9);
    }
  });

  it('has rounded lobes: a full range of heights, with gentle slopes stored without clipping', () => {
    let low = 255;
    let high = 0;
    let clipped = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      low = Math.min(low, rgba[i]!);
      high = Math.max(high, rgba[i]!);
      for (let k = 1; k < 4; k++) if (rgba[i + k] === 1 || rgba[i + k] === 255) clipped++;
    }
    expect(high - low).toBeGreaterThan(150);
    expect(clipped).toBe(0);
    expect(rgba.length).toBe(SHAPE_SIZE ** 3 * 4);
  });

  it('carves the cover it is asked for, with or without the finer octave', () => {
    // Fresh points (not the ones the levels were built from): the share above the level for f is about f.
    const rand = seeded(99);
    const points = Array.from({ length: 20_000 }, () => [rand(), rand(), rand()] as const);
    const full = points.map(([x, y, z]) => shapeAt(x, y, z));
    const coarse = points.map(([x, y, z]) => sampleShape(rgba, x, y, z));
    for (const [cut, values] of [[tables.full, full], [tables.coarse, coarse]] as const) {
      expect(cut).toHaveLength(COVER_LEVELS + 1);
      for (let i = 1; i < cut.length; i++) expect(cut[i]!).toBeGreaterThanOrEqual(cut[i - 1]!);
      for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const threshold = cut[Math.round((1 - f) * COVER_LEVELS)]!;
        const share = values.filter((v) => v > threshold).length / values.length;
        expect(Math.abs(share - f)).toBeLessThan(0.02);
      }
    }
  });

  it('knows the mean of the carved lobes, which distant views fade to', () => {
    const rand = seeded(5);
    const points = Array.from({ length: 20_000 }, () => [rand(), rand(), rand()] as const);
    for (const [cut, mean, shape] of [
      [tables.full, tables.meanFull, (p: readonly number[]) => shapeAt(p[0]!, p[1]!, p[2]!)],
      [tables.coarse, tables.meanCoarse, (p: readonly number[]) => sampleShape(rgba, p[0]!, p[1]!, p[2]!)],
    ] as const) {
      for (const i of [4, 16, 28]) {
        const measured = points.reduce((sum, p) => sum + lobe(shape(p), cut[i]!), 0) / points.length;
        expect(Math.abs(measured - mean[i]!)).toBeLessThan(0.02);
      }
      // More cover, more cloud: the mean falls as the level rises, from nearly all to none.
      for (let i = 1; i < mean.length; i++) expect(mean[i]!).toBeLessThanOrEqual(mean[i - 1]! + 1e-9);
      expect(mean[0]!).toBeGreaterThan(0.9);
      expect(mean[COVER_LEVELS]!).toBeLessThan(0.01);
    }
  });
});
