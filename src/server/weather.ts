/**
 * GET /api/v1/weather/gfs-layers/{cycle}/{hour}: the GFS fields that draw and move clouds, as GRIB2 messages back to
 * back, in file order: the ice mixing ratio at 200 hPa, the 250 hPa wind's east and north components, the ice
 * mixing ratio at 300 and 400 hPa, the 700 hPa wind, and total cloud water. The ice and the 250 hPa wind draw
 * and move the high (cirrus) layer; the rest the main deck. The client tells messages apart by their parameter
 * and level, not their order.
 *
 * The browser can't read NOAA's bucket directly (no CORS), so the Worker looks the fields up in the
 * forecast file's .idx and fetches just their byte ranges, adjacent messages merged (six ranges in all), in
 * parallel. Fields never change once published, so the response is cached at the edge and in the browser for a
 * year. Decoding happens in the browser, which keeps the Worker within the free plan's CPU limit.
 */
import { CLOUD_MAX_FORECAST_HOURS, CLOUD_STEP_HOURS, GFS_BUCKET, isCloudCycle } from '../shared/weather/gfs';
import { ApiError } from './http';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FCST = '(?:anl|\\d+ hour fcst)'; // instantaneous only, not the period averages
const field = (name: string, level: string) => new RegExp(`^\\d+:(\\d+):d=\\d{10}:${name}:${level}:${FCST}:\\s*$`);
/** The messages that draw and move the main deck: without them there are no clouds. */
const REQUIRED = [
  field('CWAT', 'entire atmosphere \\(considered as a single layer\\)'),
  field('UGRD', '700 mb'),
  field('VGRD', '700 mb'),
];
/**
 * The high layer's messages: ice above the deck and the wind near the jet stream. Every GFS v16 file has them,
 * but a step without them still draws its deck (with no high layer), so they are optional.
 */
const HIGH = [field('ICMR', '200 mb'), field('ICMR', '300 mb'), field('ICMR', '400 mb'), field('UGRD', '250 mb'), field('VGRD', '250 mb')];

/** The 1° forecast file for a cycle and hour (GFS v16 layout, March 2021 on). */
function fileUrl(cycle: string, hour: number): string {
  const day = cycle.slice(0, 8);
  const hh = cycle.slice(8);
  return `${GFS_BUCKET}/gfs.${day}/${hh}/atmos/gfs.t${hh}z.pgrb2.1p00.f${String(hour).padStart(3, '0')}`;
}

/**
 * Byte ranges of the served messages in a forecast file, in file order, adjacent ones merged; null if a deck
 * message is missing. High-layer messages are served when present.
 */
export function fieldRanges(idx: string): { start: number; end?: number }[] | null {
  const lines = idx.split('\n');
  const found: { start: number; end?: number }[] = [];
  for (const pattern of [...REQUIRED, ...HIGH]) {
    const at = lines.findIndex((l) => pattern.test(l));
    if (at < 0) {
      if (REQUIRED.includes(pattern)) return null;
      continue;
    }
    const next = lines[at + 1]?.split(':')[1];
    found.push({ start: Number(pattern.exec(lines[at]!)![1]), end: next ? Number(next) - 1 : undefined });
  }
  found.sort((a, b) => a.start - b.start);
  const ranges: { start: number; end?: number }[] = [];
  for (const r of found) {
    const last = ranges[ranges.length - 1];
    if (last && last.end !== undefined && last.end + 1 === r.start) last.end = r.end;
    else ranges.push({ ...r });
  }
  return ranges;
}

async function fetchFields(cycle: string, hour: number): Promise<Uint8Array | null> {
  const url = fileUrl(cycle, hour);
  const idx = await fetch(`${url}.idx`);
  if (!idx.ok) return null;
  const ranges = fieldRanges(await idx.text());
  if (!ranges) return null;
  const parts = await Promise.all(
    ranges.map(async (range) => {
      const res = await fetch(url, { headers: { range: `bytes=${range.start}-${range.end ?? ''}` } });
      if (res.status !== 206 && res.status !== 200) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Each range starts a GRIB2 message: "GRIB" with edition 2 in its eighth byte.
      return bytes.length < 16 || String.fromCharCode(...bytes.slice(0, 4)) !== 'GRIB' || bytes[7] !== 2 ? null : bytes;
    }),
  );
  if (parts.some((p) => !p)) return null;
  const out = new Uint8Array(parts.reduce((n, p) => n + p!.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p!, at);
    at += p!.length;
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
