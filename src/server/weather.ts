/**
 * GET /api/v1/weather/gfs/{cycle}/{hour}: the GFS fields that draw and move clouds, as three GRIB2 messages
 * back to back: total cloud water, then the 700 hPa wind's east and north components.
 *
 * The browser can't read NOAA's bucket directly (no CORS), so the Worker looks the fields up in the
 * forecast file's .idx and fetches just their byte ranges (the two wind messages are adjacent, so two
 * ranges in all). Fields never change once published, so the response is cached at the edge and in the
 * browser for a year. Decoding happens in the browser, which keeps the Worker within the free plan's CPU limit.
 */
import { CLOUD_MAX_FORECAST_HOURS, CLOUD_STEP_HOURS, GFS_BUCKET, isCloudCycle } from '../shared/weather/gfs';
import { ApiError } from './http';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FCST = '(?:anl|\\d+ hour fcst)'; // instantaneous only, not the period averages
/** The messages we serve, in order. */
const FIELDS = [
  new RegExp(`^\\d+:(\\d+):d=\\d{10}:CWAT:entire atmosphere \\(considered as a single layer\\):${FCST}:\\s*$`),
  new RegExp(`^\\d+:(\\d+):d=\\d{10}:UGRD:700 mb:${FCST}:\\s*$`),
  new RegExp(`^\\d+:(\\d+):d=\\d{10}:VGRD:700 mb:${FCST}:\\s*$`),
];

/** The 1° forecast file for a cycle and hour (GFS v16 layout, March 2021 on). */
function fileUrl(cycle: string, hour: number): string {
  const day = cycle.slice(0, 8);
  const hh = cycle.slice(8);
  return `${GFS_BUCKET}/gfs.${day}/${hh}/atmos/gfs.t${hh}z.pgrb2.1p00.f${String(hour).padStart(3, '0')}`;
}

/** Byte ranges of the served messages in a forecast file, adjacent ones merged; null if any is missing. */
export function fieldRanges(idx: string): { start: number; end?: number }[] | null {
  const lines = idx.split('\n');
  const ranges: { start: number; end?: number }[] = [];
  for (const field of FIELDS) {
    const i = lines.findIndex((l) => field.test(l));
    if (i < 0) return null;
    const start = Number(field.exec(lines[i]!)![1]);
    const next = lines[i + 1]?.split(':')[1];
    const end = next ? Number(next) - 1 : undefined;
    const last = ranges[ranges.length - 1];
    if (last && last.end !== undefined && last.end + 1 === start) last.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

async function fetchFields(cycle: string, hour: number): Promise<Uint8Array | null> {
  const url = fileUrl(cycle, hour);
  const idx = await fetch(`${url}.idx`);
  if (!idx.ok) return null;
  const ranges = fieldRanges(await idx.text());
  if (!ranges) return null;
  const parts: Uint8Array[] = [];
  for (const range of ranges) {
    const res = await fetch(url, { headers: { range: `bytes=${range.start}-${range.end ?? ''}` } });
    if (res.status !== 206 && res.status !== 200) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Each range starts a GRIB2 message: "GRIB" with edition 2 in its eighth byte.
    if (bytes.length < 16 || String.fromCharCode(...bytes.slice(0, 4)) !== 'GRIB' || bytes[7] !== 2) return null;
    parts.push(bytes);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function weatherFieldsOp(
  request: Request,
  cycle: string,
  hourText: string,
  now: number,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const hour = Number(hourText);
  if (
    !isCloudCycle(cycle, now) ||
    !/^\d{1,3}$/.test(hourText) ||
    hour % CLOUD_STEP_HOURS !== 0 ||
    hour > CLOUD_MAX_FORECAST_HOURS
  ) {
    throw new ApiError(400, 'invalid_weather_field', 'Ask for a GFS cycle (YYYYMMDDHH at 00, 06, 12 or 18 UTC, from 2021032212) and a forecast hour (0–384, every 3).');
  }
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache?.match(key);
  if (hit) return hit;

  const bytes = await fetchFields(cycle, hour);
  if (!bytes) {
    // Not published yet (or not in the archive): worth retrying later, so cache only briefly.
    throw new ApiError(404, 'weather_field_unavailable', `No weather fields for cycle ${cycle}, hour ${hour}.`, {}, { 'cache-control': 'public, max-age=600' });
  }
  const response = new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': IMMUTABLE,
      'x-content-type-options': 'nosniff',
    },
  });
  if (cache && request.method === 'GET') {
    const put = cache.put(key, response.clone());
    if (waitUntil) waitUntil(put);
    else await put;
  }
  return response;
}
