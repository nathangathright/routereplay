import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../src/server/index';
import { fieldRanges } from '../src/server/weather';
import { sceneWarnings } from '../src/shared/scene/warnings';
import { validateScene } from '../src/shared/scene/validate';
import { lookupAirport } from '../src/server/airports';
import {
  CLOUD_ARCHIVE_START_MS,
  cloudBlendAt,
  cloudFieldAt,
  cloudFieldsFor,
  cycleId,
  isCloudCycle,
  parseCycleId,
  pinnedCloudRun,
} from '../src/shared/weather/gfs';
import { leg, spec } from './helpers';

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe('choosing weather-model fields', () => {
  it('formats and parses cycle ids', () => {
    expect(cycleId(at('2026-11-11T06:00:00Z'))).toBe('2026111106');
    expect(parseCycleId('2026111106')).toBe(at('2026-11-11T06:00:00Z'));
    expect(parseCycleId('2026131106')).toBeNull();
    expect(isCloudCycle('2026111106', at('2026-11-12T00:00:00Z'))).toBe(true);
    expect(isCloudCycle('2026111103', at('2026-11-12T00:00:00Z'))).toBe(false); // not a cycle hour
    expect(isCloudCycle('2026111306', at('2026-11-12T00:00:00Z'))).toBe(false); // the future
    expect(isCloudCycle('2021032206', at('2026-11-12T00:00:00Z'))).toBe(false); // before GFS v16
    expect(isCloudCycle('2021032212', at('2026-11-12T00:00:00Z'))).toBe(true);
  });

  it('pins the newest run that is surely complete', () => {
    expect(pinnedCloudRun(at('2026-11-11T13:59:00Z'))).toBe('2026111106');
    expect(pinnedCloudRun(at('2026-11-11T12:00:00Z'))).toBe('2026111106');
    expect(pinnedCloudRun(at('2026-11-11T11:59:00Z'))).toBe('2026111100');
  });

  it('uses analysis cycles up to the run and its forecast after, within the archive and 16 days', () => {
    const run = '2026111100';
    expect(cloudFieldAt(at('2026-06-01T09:00:00Z'), run)).toEqual({ cycle: '2026060106', hour: 3, validMs: at('2026-06-01T09:00:00Z') });
    expect(cloudFieldAt(at('2026-11-11T00:00:00Z'), run)).toMatchObject({ cycle: '2026111100', hour: 0 });
    expect(cloudFieldAt(at('2026-11-12T03:00:00Z'), run)).toMatchObject({ cycle: run, hour: 27 });
    expect(cloudFieldAt(at('2026-11-27T00:00:00Z'), run)).toMatchObject({ cycle: run, hour: 384 });
    expect(cloudFieldAt(at('2026-11-27T03:00:00Z'), run)).toBeNull();
    expect(cloudFieldAt(CLOUD_ARCHIVE_START_MS - 3 * H, run)).toBeNull();
    expect(cloudFieldAt(at('2026-06-01T10:00:00Z'), run)).toBeNull(); // not on the 3-hour grid
  });

  it('brackets a journey and coarsens the step for long ones', () => {
    const short = cloudFieldsFor(at('2026-06-01T10:30:00Z'), at('2026-06-01T15:10:00Z'), '2026111100');
    expect(short.stepHours).toBe(3);
    expect(short.fields.map((f) => new Date(f.validMs).toISOString().slice(11, 13))).toEqual(['09', '12', '15', '18']);
    const long = cloudFieldsFor(at('2026-06-01T00:00:00Z'), at('2026-06-08T00:00:00Z'), '2026111100');
    expect(long.fields.length).toBeLessThanOrEqual(24);
    expect(long.stepHours % 3).toBe(0);
  });

  it('blends between neighbours and fades out at the edge of the data', () => {
    const step = 3;
    const t = at('2026-06-01T10:00:00Z');
    expect(cloudBlendAt(t, step, () => true)).toEqual({ a: at('2026-06-01T09:00:00Z'), b: at('2026-06-01T12:00:00Z'), mix: 1 / 3, presence: 1 });
    expect(cloudBlendAt(t, step, (v) => v === at('2026-06-01T09:00:00Z'))?.presence).toBeCloseTo(2 / 3);
    expect(cloudBlendAt(t, step, (v) => v === at('2026-06-01T12:00:00Z'))?.presence).toBeCloseTo(1 / 3);
    expect(cloudBlendAt(t, step, () => false)).toBeNull();
  });
});

describe('scenes with clouds', () => {
  const opts = { lookupAirport, airportDataVersion: 'test' };
  const trip = spec([leg('out', 'ORD', 'SFO', '2026-10-05T10:00:00-05:00', '2026-10-05T12:45:00-07:00')]);

  it('defaults to clouds and pins the run at save time', () => {
    const saved = validateScene(trip, { ...opts, now: at('2026-11-11T14:00:00Z') });
    expect(saved.ok && saved.normalized.environment).toEqual({ weather: 'clouds', cloudRun: '2026111106' });
    const off = validateScene({ ...trip, environment: { weather: 'omitted' } }, { ...opts, now: at('2026-11-11T14:00:00Z') });
    expect(off.ok && off.normalized.environment).toEqual({ weather: 'omitted' });
  });

  it('warns when model data covers only part of the journey', () => {
    const now = at('2026-11-11T14:00:00Z');
    const covered = validateScene(trip, { ...opts, now });
    expect(covered.ok && sceneWarnings(covered.normalized, now).map((w) => w.code)).toEqual([]);
    const later = spec([leg('out', 'ORD', 'SFO', '2026-12-20T10:00:00-06:00', '2026-12-20T12:45:00-08:00')]);
    const ahead = validateScene(later, { ...opts, now });
    expect(ahead.ok && sceneWarnings(ahead.normalized, now).map((w) => w.code)).toEqual(['no_cloud_data']);
  });
});

describe('weather field endpoint', () => {
  // Any real GRIB2 message stands in for each field; the endpoint only cuts and joins them.
  const grib = new Uint8Array(readFileSync(new URL('./fixtures/gfs-tcdc-1p00.grb2', import.meta.url).pathname));
  const n = grib.length;
  const idx = [
    `420:1000000:d=2026111100:UGRD:700 mb:6 hour fcst:`,
    `421:${1000000 + n}:d=2026111100:VGRD:700 mb:6 hour fcst:`,
    `422:${1000000 + 2 * n}:d=2026111100:TMP:700 mb:6 hour fcst:`,
    `627:3000000:d=2026111100:CWAT:entire atmosphere (considered as a single layer):6 hour fcst:`,
    `628:${3000000 + n}:d=2026111100:RH:entire atmosphere (considered as a single layer):6 hour fcst:`,
    '',
  ].join('\n');
  const env = { DB: undefined as never };
  afterEach(() => vi.unstubAllGlobals());

  it('finds cloud water and the 700 hPa wind, merging the adjacent wind messages', () => {
    expect(fieldRanges(idx)).toEqual([
      { start: 3000000, end: 3000000 + n - 1 },
      { start: 1000000, end: 1000000 + 2 * n - 1 },
    ]);
    expect(fieldRanges('1:0:d=2026111100:PRMSL:mean sea level:anl:\n')).toBeNull();
  });

  it('serves the fields for one step by range request and rejects anything else', async () => {
    const ranges: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range');
      if (url.endsWith('/gfs.20261111/00/atmos/gfs.t00z.pgrb2.1p00.f006.idx')) return new Response(idx);
      if (url.endsWith('/gfs.20261111/00/atmos/gfs.t00z.pgrb2.1p00.f006') && range) {
        ranges.push(range);
        const [a, b] = range.slice(6).split('-').map(Number);
        const count = (b! - a! + 1) / n;
        const body = new Uint8Array(n * count);
        for (let i = 0; i < count; i++) body.set(grib, i * n);
        return new Response(body, { status: 206 });
      }
      return new Response('missing', { status: 404 });
    });
    const res = await handle(new Request('https://rr.test/api/v1/weather/gfs/2026111100/6'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(3 * n);
    expect(ranges).toEqual([`bytes=3000000-${3000000 + n - 1}`, `bytes=1000000-${1000000 + 2 * n - 1}`]);

    // Not published yet: a short-lived 404.
    const missing = await handle(new Request('https://rr.test/api/v1/weather/gfs/2026111106/6'), env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toMatch(/max-age=600/);

    for (const bad of ['2026111103/6', '2026111100/7', '2026111100/387', '2020010100/0', 'nonsense/0']) {
      expect((await handle(new Request(`https://rr.test/api/v1/weather/gfs/${bad}`), env)).status).toBe(400);
    }
  });
});
