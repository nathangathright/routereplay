import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM } from '../src/shared/geo/greatCircle';
import { add, cross, dot, length, normalize as unit, scale, vecToLatLon } from '../src/shared/geo/vec';
import { ASSET_MANIFEST_VERSION } from '../src/shared/scene/constants';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import { buildTimeline, cameraPositionAt } from '../src/shared/timeline/evaluate';
import {
  DETAIL_COLUMNS,
  DETAIL_DEGREES,
  DETAIL_FADE,
  DETAIL_ROWS,
  angleToCell,
  cellHasTile,
  detailRadius,
  planNightDetail,
  tileName,
} from '../src/shared/timeline/nightDetail';
import { leg, normalize, spec } from './helpers';

const DIR = new URL(`../public/assets/${ASSET_MANIFEST_VERSION}/`, import.meta.url).pathname;
const DEG = Math.PI / 180;
const cellOf = (lat: number, lon: number) =>
  Math.min(DETAIL_ROWS - 1, Math.floor((lat + 90) / DETAIL_DEGREES)) * DETAIL_COLUMNS +
  (((Math.floor((lon + 180) / DETAIL_DEGREES) % DETAIL_COLUMNS) + DETAIL_COLUMNS) % DETAIL_COLUMNS);

/** Evening JFK to Boston: the camera stays low over the whole north-east corridor. */
const jfkBos = () => buildTimeline(normalize(spec([leg('a', 'JFK', 'BOS', '2027-02-10T20:30:00-05:00', '2027-02-10T21:45:00-05:00')])));

describe('night-detail tiles', () => {
  it('names cells by their south-west corner', () => {
    expect(tileName(cellOf(51.47, -0.45))).toBe('N50W005.webp');
    expect(tileName(cellOf(-37, 174.8))).toBe('S40E170.webp');
    expect(tileName(0)).toBe('S90W180.webp');
    expect(tileName(DETAIL_ROWS * DETAIL_COLUMNS - 1)).toBe('N85E175.webp');
  });

  it('lists exactly the cells that have a tile at both qualities', () => {
    let count = 0;
    for (let cell = 0; cell < DETAIL_ROWS * DETAIL_COLUMNS; cell++) {
      const name = tileName(cell);
      expect(existsSync(`${DIR}earth-night-detail-standard/${name}`), name).toBe(cellHasTile(cell));
      expect(existsSync(`${DIR}earth-night-detail-low/${name}`), name).toBe(cellHasTile(cell));
      if (cellHasTile(cell)) count++;
    }
    expect(count).toBe(1215);
    expect(cellHasTile(cellOf(40.64, -73.78))).toBe(true); // New York
    expect(cellHasTile(cellOf(-85, 0))).toBe(false); // inland Antarctica
  });
});

describe('angle to a cell', () => {
  it('is zero inside and exact along meridians and the equator', () => {
    expect(angleToCell(52, -2, cellOf(52, -2))).toBe(0);
    expect(angleToCell(0, 0, cellOf(12, 2))).toBeCloseTo(10 * DEG, 12);
    expect(angleToCell(0, 12, cellOf(2, 2))).toBeCloseTo(7 * DEG, 12);
    // Across the date line.
    expect(angleToCell(0, 179, cellOf(0, -178))).toBeCloseTo(1 * DEG, 12);
  });

  it('matches the nearest of many points in the cell', () => {
    let seed = 7;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 300; i++) {
      const lat = rand() * 170 - 85;
      const lon = rand() * 360 - 180;
      const cell = cellOf(rand() * 170 - 85, rand() * 360 - 180);
      const lat0 = Math.floor(cell / DETAIL_COLUMNS) * DETAIL_DEGREES - 90;
      const lon0 = (cell % DETAIL_COLUMNS) * DETAIL_DEGREES - 180;
      let nearest = Infinity;
      for (let a = 0; a <= 40; a++) {
        for (let b = 0; b <= 40; b++) {
          const p = (lat0 + (a / 40) * DETAIL_DEGREES) * DEG;
          const q = (lon0 + (b / 40) * DETAIL_DEGREES - lon) * DEG;
          const c = Math.sin(lat * DEG) * Math.sin(p) + Math.cos(lat * DEG) * Math.cos(p) * Math.cos(q);
          nearest = Math.min(nearest, Math.acos(Math.min(1, c)));
        }
      }
      const angle = angleToCell(lat, lon, cell);
      expect(angle).toBeLessThanOrEqual(nearest + 1e-9);
      expect(angle).toBeGreaterThan(nearest - 0.1 * DEG);
    }
  });
});

describe('detail radius', () => {
  const spread = (d: number, theta: number) => (d * d + 1 - 2 * d * Math.cos(theta)) / (d * Math.cos(theta) - 1);

  it('reaches the sides of a 16:9 frame at the closest airport framing', () => {
    const tl = jfkBos();
    const camera = cameraPositionAt(tl, 0);
    const radius = detailRadius(camera)!;
    expect(Math.round((radius * EARTH_RADIUS_KM) / 10) * 10).toBe(1540);
    // The detail is whole out to where the spread reaches the fade's start.
    let inner = 0;
    while (spread(length(camera), inner + 1e-5) < DETAIL_FADE[0]) inner += 1e-5;
    expect(Math.round((inner * EARTH_RADIUS_KM) / 10) * 10).toBe(1210);
    // Where the detail ends, the camera's distance over the cosine of the viewing angle is the fade's end.
    expect(spread(length(camera), radius)).toBeCloseTo(DETAIL_FADE[1], 9);
    expect(spread(length(camera), 0)).toBeLessThan(DETAIL_FADE[0]);
  });

  it('is gone with the camera high up', () => {
    expect(detailRadius([1 + DETAIL_FADE[1] + 1e-6, 0, 0])).toBeNull();
    expect(detailRadius([2.02, 0, 0])).toBeNull(); // mid-flight on a trip's longest leg
  });
});

describe('planning', () => {
  it('starts at the first airport and orders cells by when they are first needed', () => {
    const tl = jfkBos();
    const plan = planNightDetail(tl, 1000);
    expect(tileName(plan[0]!.cell)).toBe('N40W075.webp');
    expect(plan[0]!.frame).toBe(0);
    expect(new Set(plan.map((c) => c.cell)).size).toBe(plan.length);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.frame).toBeGreaterThanOrEqual(plan[i - 1]!.frame);
    expect(plan.map((c) => c.lit)).toEqual(plan.map((c) => cellHasTile(c.cell)));
    expect(planNightDetail(tl, 1000)).toEqual(plan);
  });

  it('covers every point that draws detail, from the first frame that does', () => {
    for (const tl of [jfkBos(), buildTimeline(normalize(EXAMPLE_SCENE))]) {
      const plan = planNightDetail(tl, 1000);
      const firstFrame = new Map(plan.map((c) => [c.cell, c.frame]));
      for (let frame = 0; frame < tl.durationInFrames; frame += 3) {
        const camera = cameraPositionAt(tl, frame / tl.fps);
        const radius = detailRadius(camera);
        if (radius === null) continue;
        // Points on rings around the point below the camera, out to the detail's edge.
        const n = unit(camera);
        const east = unit(cross([0, 1, 0], n), [1, 0, 0]);
        const north = cross(n, east);
        for (let r = 0; r <= 8; r++) {
          const angle = (radius * r) / 8.0001;
          for (let k = 0; k < 64; k++) {
            const bearing = (2 * Math.PI * k) / 64;
            const dir = add(scale(east, Math.sin(bearing)), scale(north, Math.cos(bearing)));
            const p = add(scale(n, Math.cos(angle)), scale(dir, Math.sin(angle)));
            const { lat, lon } = vecToLatLon(p);
            const first = firstFrame.get(cellOf(lat, lon));
            expect(first, `frame ${frame}, ${lat.toFixed(2)}, ${lon.toFixed(2)}`).toBeDefined();
            expect(first!).toBeLessThanOrEqual(frame);
          }
        }
        expect(dot(n, n)).toBeCloseTo(1, 12);
      }
    }
  });

  it('stops at the tile cap, keeping the earliest cells', () => {
    const tl = buildTimeline(normalize(EXAMPLE_SCENE));
    const full = planNightDetail(tl, 1000);
    const capped = planNightDetail(tl, 20);
    expect(capped.filter((c) => c.lit)).toHaveLength(20);
    expect(capped).toEqual(full.slice(0, capped.length));
    expect(full[capped.length]!.lit).toBe(true);
  });
});
