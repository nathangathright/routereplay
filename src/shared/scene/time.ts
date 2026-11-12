/**
 * Offset-aware timestamp parsing and IANA time-zone checks.
 *
 * Every timestamp in an authoring spec must carry an explicit UTC offset (or `Z`).
 * The offset must equal the airport's legal offset at that instant, which catches
 * daylight-saving mistakes before they reach the scene.
 */

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ParsedTimestamp {
  utcMs: number;
  /** Offset written in the timestamp, in minutes east of UTC. */
  offsetMinutes: number;
  wall: WallTime;
}

export type ParseTimestampError = 'timestamp_format' | 'invalid_date';

export function parseOffsetTimestamp(value: string): ParsedTimestamp | ParseTimestampError {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return 'timestamp_format';
  const [, y, mo, d, h, mi, s, ms, off] = m as unknown as string[];
  const wall: WallTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s === undefined ? 0 : Number(s),
  };
  const millis = ms === undefined ? 0 : Number(ms.padEnd(3, '0'));
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return 'invalid_date';
  const wallMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, millis);
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== wall.year ||
    check.getUTCMonth() !== wall.month - 1 ||
    check.getUTCDate() !== wall.day
  ) {
    return 'invalid_date';
  }
  let offsetMinutes = 0;
  if (off !== 'Z') {
    const sign = off!.startsWith('-') ? -1 : 1;
    const oh = Number(off!.slice(1, 3));
    const om = Number(off!.slice(4, 6));
    if (oh > 18 || om > 59) return 'timestamp_format';
    offsetMinutes = sign * (oh * 60 + om);
  }
  return { utcMs: wallMs - offsetMinutes * 60_000, offsetMinutes, wall };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC in minutes at the given instant (whole-second precision). */
export function zoneOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(Math.floor(utcMs / 1000) * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** All UTC instants whose local wall time in `timeZone` equals `wall` (0, 1, or 2 results). */
export function resolveWallTime(timeZone: string, wall: WallTime): { utcMs: number; offsetMinutes: number }[] {
  const wallMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const candidates = new Set<number>([
    zoneOffsetMinutes(timeZone, wallMs - 36 * 3_600_000),
    zoneOffsetMinutes(timeZone, wallMs),
    zoneOffsetMinutes(timeZone, wallMs + 36 * 3_600_000),
  ]);
  const out: { utcMs: number; offsetMinutes: number }[] = [];
  for (const offset of candidates) {
    const utcMs = wallMs - offset * 60_000;
    if (zoneOffsetMinutes(timeZone, utcMs) === offset) out.push({ utcMs, offsetMinutes: offset });
  }
  return out.sort((a, b) => a.utcMs - b.utcMs);
}

export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Format an instant as an ISO-8601 local timestamp with an explicit offset, e.g. 2031-01-05T10:00:00-06:00. */
export function formatLocalTimestamp(utcMs: number, offsetMinutes: number): string {
  const d = new Date(utcMs + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${formatOffset(offsetMinutes)}`
  );
}

export function formatUtc(utcMs: number): string {
  return new Date(utcMs).toISOString().replace('.000Z', 'Z');
}

export function wallToString(w: WallTime): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}
