/**
 * Clouds from NOAA's Global Forecast System (GFS), published on AWS Open Data: one global field of total
 * cloud water ("CWAT:entire atmosphere", kg/m²) on a 1° grid every 3 hours, cut out of the model output by
 * HTTP range request (about 90 KB each). Cloud water tracks how thick, and so how bright, clouds look from
 * space far better than cloud-cover fraction, which reads 100 % under thin cirrus.
 *
 * A scene pins one model run when it is saved. Times up to that run use the 6-hourly analysis cycles (the
 * model's best estimate of what was there); later times use that run's forecast, up to 16 days ahead.
 * Outside the archive and the forecast range there is no field, and no clouds are drawn.
 */

const HOUR = 3_600_000;

export const GFS_BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
/** Fields exist every 3 hours (analysis cycles at 00/06/12/18 UTC, each with a 3-hour forecast). */
export const CLOUD_STEP_HOURS = 3;
/**
 * The first cycle of GFS v16 (12 UTC on 22 March 2021), whose file layout and analysis fields we read.
 * Earlier files in the archive differ (no analysis cloud fields, another directory layout).
 */
export const CLOUD_ARCHIVE_START_MS = Date.UTC(2021, 2, 22, 12);
export const CLOUD_MAX_FORECAST_HOURS = 384;
/** GFS publishes a run's last forecast hour about 5 hours after its cycle time; a save pins one surely complete. */
const RUN_LAG_HOURS = 6;
/** Grid of each field: 1°, 360 × 181, rows from 90°N to 90°S, columns from 0° eastward. */
export const CLOUD_GRID = { nx: 360, ny: 181 } as const;

export interface CloudField {
  /** Model cycle, YYYYMMDDHH (UTC). */
  cycle: string;
  /** Forecast hour within the cycle (0 = analysis). */
  hour: number;
  /** When the field is valid, ms since the epoch. */
  validMs: number;
}

const floorTo = (ms: number, hours: number) => Math.floor(ms / (hours * HOUR)) * hours * HOUR;

/** "2026111106" for 06:00 UTC on 11 November 2026. */
export const cycleId = (ms: number): string => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');

export function parseCycleId(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  return cycleId(ms) === id ? ms : null;
}

/** True for a GFS cycle we can serve: on a 6-hour boundary, from GFS v16 on, and not after `nowMs`. */
export function isCloudCycle(id: string, nowMs: number): boolean {
  const ms = parseCycleId(id);
  return ms !== null && ms % (6 * HOUR) === 0 && ms >= CLOUD_ARCHIVE_START_MS && ms <= nowMs;
}

/** The newest run that is surely complete at `nowMs`: what a save pins. */
export function pinnedCloudRun(nowMs: number): string {
  return cycleId(floorTo(nowMs - RUN_LAG_HOURS * HOUR, 6));
}

/** The field valid at `validMs` (a multiple of 3 hours) for a scene pinned to `run`, or null where none exists. */
export function cloudFieldAt(validMs: number, run: string): CloudField | null {
  const runMs = parseCycleId(run);
  if (runMs === null || validMs < CLOUD_ARCHIVE_START_MS || validMs % (CLOUD_STEP_HOURS * HOUR) !== 0) return null;
  if (validMs <= runMs) {
    const cycleMs = floorTo(validMs, 6);
    return { cycle: cycleId(cycleMs), hour: (validMs - cycleMs) / HOUR, validMs };
  }
  const hour = (validMs - runMs) / HOUR;
  return hour <= CLOUD_MAX_FORECAST_HOURS ? { cycle: run, hour, validMs } : null;
}

/**
 * The fields to load for a span of physical time: every `stepHours` from just before `startMs` to just
 * after `endMs`. Long journeys use a coarser step so they stay within `maxFields` downloads.
 */
export function cloudFieldsFor(
  startMs: number,
  endMs: number,
  run: string,
  maxFields = 24,
): { stepHours: number; fields: CloudField[] } {
  let stepHours = CLOUD_STEP_HOURS;
  while ((endMs - startMs) / (stepHours * HOUR) + 2 > maxFields) stepHours += CLOUD_STEP_HOURS;
  const first = floorTo(startMs, stepHours);
  const last = Math.ceil(endMs / (stepHours * HOUR)) * stepHours * HOUR;
  const fields: CloudField[] = [];
  for (let t = first; t <= last; t += stepHours * HOUR) {
    const f = cloudFieldAt(t, run);
    if (f) fields.push(f);
  }
  return { stepHours, fields };
}

/**
 * How to draw clouds at `utcMs` from fields every `stepHours`: the two neighbouring fields' valid times,
 * how far to blend from the first to the second, and how present the clouds are. Where only one neighbour
 * exists (the edge of the archive or forecast), clouds fade out over one step.
 */
export function cloudBlendAt(
  utcMs: number,
  stepHours: number,
  has: (validMs: number) => boolean,
): { a: number; b: number; mix: number; presence: number } | null {
  const step = stepHours * HOUR;
  const a = floorTo(utcMs, stepHours);
  const b = a + step;
  const mix = (utcMs - a) / step;
  const hasA = has(a);
  const hasB = has(b);
  if (hasA && hasB) return { a, b, mix, presence: 1 };
  if (hasA) return { a, b: a, mix: 0, presence: 1 - mix };
  if (hasB) return { a: b, b, mix: 0, presence: mix };
  return null;
}
