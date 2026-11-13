import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSET_MANIFEST_VERSION } from '../src/shared/scene/constants';
import { DAY_TEXTURE_WIDTHS, currentSurfaceMonth, dayTextureWidth, journeySurfaceMonth } from '../src/shared/scene/surface';
import type { NormalizedSceneV1 } from '../src/shared/scene/types';
import { DETAIL_DEGREES, DETAIL_TILE } from '../src/shared/timeline/nightDetail';

const ASSETS = new URL('../public/assets/', import.meta.url).pathname;
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/publication-v1.json', import.meta.url).pathname, 'utf8')) as {
  scene: NormalizedSceneV1;
};

const departing = (departureLocal: string) => ({ legs: [{ departureLocal }] }) as Pick<NormalizedSceneV1, 'legs'>;

describe('surface month', () => {
  it("uses the first departure's month in the origin's local time", () => {
    expect(journeySurfaceMonth(FIXTURE.scene)).toBe(1); // departs 2031-01-05 in Chicago
    expect(journeySurfaceMonth(departing('2026-10-05T07:00:00-05:00'))).toBe(10);
  });

  it('follows the local date where it differs from UTC', () => {
    // 23:30 on 31 October in San Francisco is already 1 November in UTC.
    expect(journeySurfaceMonth(departing('2026-10-31T23:30:00-07:00'))).toBe(10);
    // 08:00 on 1 January in Tokyo is still 31 December in UTC.
    expect(journeySurfaceMonth(departing('2027-01-01T08:00:00+09:00'))).toBe(1);
  });

  it('uses the current UTC month on the homepage', () => {
    expect(currentSurfaceMonth(Date.UTC(2026, 10, 12, 4))).toBe(11);
    expect(currentSurfaceMonth(Date.UTC(2026, 11, 31, 23, 59))).toBe(12);
  });
});

describe('day texture width', () => {
  it('gives phones 4096 and capable devices 8192', () => {
    expect(dayTextureWidth('low', 16384)).toBe(4096);
    expect(dayTextureWidth('standard', 16384)).toBe(8192);
    expect(dayTextureWidth('standard', 8192)).toBe(8192);
  });

  it('never asks a device for more than its largest texture', () => {
    expect(dayTextureWidth('standard', 4096)).toBe(4096);
    expect(dayTextureWidth('standard', 6144)).toBe(4096);
    // Below the smallest file, three.js scales the 4096 image down.
    expect(dayTextureWidth('low', 2048)).toBe(4096);
  });
});

describe('asset directory', () => {
  const dir = `${ASSETS}${ASSET_MANIFEST_VERSION}/`;
  const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
    version: string;
    files: {
      path: string;
      kind: string;
      month?: number;
      width?: number;
      quality?: 'low' | 'standard';
      degrees?: number;
      gutter?: number;
      tiles?: number;
      bytes: number;
      sha256: string;
    }[];
  };
  const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

  it('has a day texture for every month and a water mask at every width', () => {
    expect(manifest.version).toBe(ASSET_MANIFEST_VERSION);
    for (const width of DAY_TEXTURE_WIDTHS) {
      for (let month = 1; month <= 12; month++) {
        const mm = String(month).padStart(2, '0');
        const file = manifest.files.find((f) => f.path === `earth-day-${mm}-${width}.webp`);
        expect(file, `earth-day-${mm}-${width}.webp`).toMatchObject({ kind: 'earth-day', month, width });
      }
      const water = manifest.files.find((f) => f.path === `earth-water-${width}.webp`);
      expect(water, `earth-water-${width}.webp`).toMatchObject({ kind: 'earth-water', width });
    }
    for (const name of ['earth-night-low.webp', 'earth-night-standard.webp', 'earth-relief-low.webp', 'earth-relief-standard.webp', 'Dosis-Variable.ttf', 'OFL.txt', 'BarlowCondensed-SemiBold.ttf', 'BarlowCondensed-OFL.txt']) {
      expect(existsSync(`${dir}${name}`), name).toBe(true);
    }
  });

  it('matches the hashes in its manifest', () => {
    for (const f of manifest.files) {
      if (f.tiles !== undefined) continue;
      const bytes = readFileSync(`${dir}${f.path}`);
      expect(bytes.length, f.path).toBe(f.bytes);
      expect(sha256(bytes), f.path).toBe(f.sha256);
    }
  });

  it('has night-detail tiles at each quality, laid out as the renderer reads them', () => {
    for (const quality of ['standard', 'low'] as const) {
      const record = manifest.files.find((f) => f.kind === 'earth-night-detail' && f.quality === quality);
      const { cell, gutter } = DETAIL_TILE[quality];
      expect(record, quality).toMatchObject({ path: `earth-night-detail-${quality}`, degrees: DETAIL_DEGREES, width: cell + 2 * gutter, gutter });
      // The record hashes a sha256sum-style listing of the directory.
      const names = readdirSync(`${dir}${record!.path}`).sort();
      const files = names.map((name) => readFileSync(`${dir}${record!.path}/${name}`));
      expect(names.length).toBe(record!.tiles);
      expect(files.reduce((a, b) => a + b.length, 0)).toBe(record!.bytes);
      expect(sha256(names.map((name, i) => `${sha256(files[i]!)}  ${name}\n`).join(''))).toBe(record!.sha256);
    }
  });

  it('keeps the directory the published fixture was saved with', () => {
    expect(existsSync(`${ASSETS}${FIXTURE.scene.compatibility.assetManifestVersion}/manifest.json`)).toBe(true);
  });
});
