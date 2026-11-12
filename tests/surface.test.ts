import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSET_MANIFEST_VERSION } from '../src/shared/scene/constants';
import { DAY_TEXTURE_WIDTHS, currentSurfaceMonth, dayTextureWidth, journeySurfaceMonth } from '../src/shared/scene/surface';
import type { NormalizedSceneV1 } from '../src/shared/scene/types';

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
    files: { path: string; kind: string; month?: number; width?: number; bytes: number; sha256: string }[];
  };

  it('has a day texture for every month at every width', () => {
    expect(manifest.version).toBe(ASSET_MANIFEST_VERSION);
    for (let month = 1; month <= 12; month++) {
      for (const width of DAY_TEXTURE_WIDTHS) {
        const mm = String(month).padStart(2, '0');
        const file = manifest.files.find((f) => f.path === `earth-day-${mm}-${width}.webp`);
        expect(file, `earth-day-${mm}-${width}.webp`).toMatchObject({ kind: 'earth-day', month, width });
      }
    }
    for (const name of ['earth-night-low.jpg', 'earth-night-standard.jpg', 'earth-water.png', 'Dosis-Variable.ttf', 'OFL.txt']) {
      expect(existsSync(`${dir}${name}`), name).toBe(true);
    }
  });

  it('matches the hashes in its manifest', () => {
    for (const f of manifest.files) {
      const bytes = readFileSync(`${dir}${f.path}`);
      expect(bytes.length, f.path).toBe(f.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), f.path).toBe(f.sha256);
    }
  });

  it('keeps the directory the published fixture was saved with', () => {
    expect(existsSync(`${ASSETS}${FIXTURE.scene.compatibility.assetManifestVersion}/manifest.json`)).toBe(true);
  });
});
